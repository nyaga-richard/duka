-- Reviewed carry-forward of legacy customer/supplier ADVANCE CREDITS in
-- addition to positive debt. Positive amounts with an explicit direction; a
-- credit is never a negative debt and never generates cash, revenue, VAT or
-- stock. Credits are recognized against opening equity and become real,
-- allocatable advance_credits usable by the ordinary advance engine.
ALTER TABLE opening_items ADD COLUMN direction text NOT NULL DEFAULT 'debt' CHECK(direction IN ('debt','credit'));
DROP INDEX opening_item_reference;
CREATE UNIQUE INDEX opening_item_reference ON opening_items(company_id,batch_id,kind,coalesce(customer_id,supplier_id),reference_key,direction);
CREATE INDEX opening_item_credit_source ON advance_credits(company_id,source_type,source_id) WHERE source_type='opening_balance';

-- Duplicate protection and operational-invoice separation stay scoped to
-- genuine debt; a same named legacy reference may exist as both debt and
-- credit (they are different economic remainders), never twice as the same
-- direction on an active posted import for the same branch.
CREATE OR REPLACE FUNCTION guard_opening_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c date;earliest date;party record;
BEGIN
 IF TG_OP='INSERT' THEN IF NEW.status<>'draft' THEN RAISE EXCEPTION 'Opening batches must begin as drafts' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 IF TG_OP='DELETE' OR OLD.status IN ('posted','cancelled') THEN RAISE EXCEPTION 'Posted/cancelled opening batches cannot be edited or deleted' USING ERRCODE='23514';END IF;
 IF NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.created_by<>OLD.created_by THEN RAISE EXCEPTION 'Opening batch identity cannot change' USING ERRCODE='23514';END IF;
 IF OLD.status='submitted' AND (NEW.branch_id<>OLD.branch_id OR NEW.accounting_date<>OLD.accounting_date OR NEW.reference<>OLD.reference OR NEW.notes<>OLD.notes) THEN RAISE EXCEPTION 'Submitted opening content cannot change' USING ERRCODE='23514';END IF;
 IF NOT((OLD.status='draft' AND NEW.status IN ('draft','submitted','cancelled')) OR(OLD.status='submitted' AND NEW.status IN ('draft','posted','cancelled'))) THEN RAISE EXCEPTION 'Invalid opening batch transition' USING ERRCODE='23514';END IF;
 IF NEW.status IN ('submitted','posted') AND NOT EXISTS(SELECT 1 FROM opening_items WHERE company_id=NEW.company_id AND batch_id=NEW.id) THEN RAISE EXCEPTION 'Opening batch needs positive items' USING ERRCODE='23514';END IF;
 IF NEW.status='posted' THEN
  FOR party IN SELECT kind,coalesce(customer_id,supplier_id) AS id FROM opening_items WHERE company_id=NEW.company_id AND batch_id=NEW.id GROUP BY kind,coalesce(customer_id,supplier_id) ORDER BY kind,coalesce(customer_id,supplier_id) LOOP
   IF party.kind='customer' THEN PERFORM id FROM customers WHERE company_id=NEW.company_id AND id=party.id FOR UPDATE;ELSE PERFORM id FROM suppliers WHERE company_id=NEW.company_id AND id=party.id FOR UPDATE;END IF;
  END LOOP;
  PERFORM lock_opening_boundary(NEW.company_id,NEW.branch_id);
  SELECT accounting_date INTO c FROM opening_cutovers WHERE company_id=NEW.company_id AND branch_id=NEW.branch_id;
  IF c IS NOT NULL AND c<>NEW.accounting_date THEN RAISE EXCEPTION 'Branch opening cutover date is fixed' USING ERRCODE='23514';END IF;
  SELECT min(accounting_date) INTO earliest FROM journals WHERE company_id=NEW.company_id AND branch_id=NEW.branch_id AND source_type IN ('sale','sale_return','customer_receipt','supplier_invoice','supplier_payment','supplier_return','supplier_credit_settlement','advance_allocation','opening_allocation');
  IF earliest<=NEW.accounting_date THEN RAISE EXCEPTION 'Opening date must precede all existing branch debt activity' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM opening_items i JOIN opening_items p ON p.company_id=i.company_id AND p.kind=i.kind AND p.direction=i.direction AND coalesce(p.customer_id,p.supplier_id)=coalesce(i.customer_id,i.supplier_id) AND p.reference_key=i.reference_key AND p.batch_id<>i.batch_id JOIN opening_batches b ON b.company_id=p.company_id AND b.id=p.batch_id WHERE i.company_id=NEW.company_id AND i.batch_id=NEW.id AND b.branch_id=NEW.branch_id AND b.status='posted' AND NOT EXISTS(SELECT 1 FROM opening_batch_reversals r WHERE r.company_id=b.company_id AND r.batch_id=b.id)) THEN RAISE EXCEPTION 'Legacy opening reference already imported' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM opening_items i JOIN supplier_invoices p ON p.company_id=i.company_id AND p.supplier_id=i.supplier_id AND lower(btrim(p.supplier_reference))=i.reference_key WHERE i.company_id=NEW.company_id AND i.batch_id=NEW.id AND i.kind='supplier' AND i.direction='debt') THEN RAISE EXCEPTION 'Supplier invoice already exists in the operational ledger' USING ERRCODE='23514';END IF;
  INSERT INTO opening_cutovers(company_id,branch_id,accounting_date,created_by) VALUES(NEW.company_id,NEW.branch_id,NEW.accounting_date,NEW.posted_by) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;

-- Operational supplier invoices keep colliding only with imported legacy DEBT,
-- not with a legacy advance of the same reference.
CREATE OR REPLACE FUNCTION guard_opening_supplier_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM suppliers WHERE company_id=NEW.company_id AND id=NEW.supplier_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM opening_items i JOIN opening_batches b ON b.company_id=i.company_id AND b.id=i.batch_id WHERE i.company_id=NEW.company_id AND i.supplier_id=NEW.supplier_id AND i.direction='debt' AND i.reference_key=lower(btrim(NEW.supplier_reference)) AND b.status='posted' AND NOT EXISTS(SELECT 1 FROM opening_batch_reversals r WHERE r.company_id=b.company_id AND r.batch_id=b.id)) THEN RAISE EXCEPTION 'Supplier legacy reference already imported as an opening payable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

-- Opening allocations target imported debt only; credits are consumed by the
-- advance engine (future invoices, or apply-credit onto opening debt).
CREATE OR REPLACE FUNCTION guard_opening_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i opening_items;b opening_batches;receipt customer_receipts;pay supplier_payments;credit advance_credits;used numeric;source_amount numeric;source_date date;last_date date;
BEGIN
 SELECT * INTO STRICT i FROM opening_items WHERE company_id=NEW.company_id AND id=NEW.item_id;
 IF i.direction<>'debt' THEN RAISE EXCEPTION 'Opening allocations settle imported debt only; use the advance engine for legacy credits' USING ERRCODE='23514';END IF;
 IF i.kind='customer' THEN PERFORM id FROM customers WHERE company_id=NEW.company_id AND id=i.customer_id FOR UPDATE;ELSE PERFORM id FROM suppliers WHERE company_id=NEW.company_id AND id=i.supplier_id FOR UPDATE;END IF;
 PERFORM id FROM opening_items WHERE company_id=NEW.company_id AND id=i.id FOR UPDATE;
 SELECT * INTO STRICT b FROM opening_batches WHERE company_id=NEW.company_id AND id=i.batch_id;
 IF b.status<>'posted' OR EXISTS(SELECT 1 FROM opening_batch_reversals WHERE company_id=NEW.company_id AND batch_id=b.id) OR NEW.accounting_date<=b.accounting_date THEN RAISE EXCEPTION 'Opening item is not open on this allocation date' USING ERRCODE='23514';END IF;
 SELECT max(accounting_date) INTO last_date FROM opening_allocations WHERE company_id=NEW.company_id AND item_id=i.id;
 IF NEW.accounting_date<last_date OR NEW.amount>opening_item_balance(NEW.company_id,i.id) THEN RAISE EXCEPTION 'Opening over-allocation or chronology conflict' USING ERRCODE='23514';END IF;
 IF NEW.receipt_id IS NOT NULL THEN
  SELECT * INTO STRICT receipt FROM customer_receipts WHERE company_id=NEW.company_id AND id=NEW.receipt_id FOR UPDATE;
  IF i.kind<>'customer' OR receipt.customer_id<>i.customer_id OR receipt.branch_id<>b.branch_id THEN RAISE EXCEPTION 'Opening receipt contact/branch mismatch' USING ERRCODE='23514';END IF;
  SELECT coalesce((SELECT sum(amount) FROM customer_allocations WHERE company_id=NEW.company_id AND receipt_id=NEW.receipt_id),0)+coalesce((SELECT sum(amount) FROM opening_allocations WHERE company_id=NEW.company_id AND receipt_id=NEW.receipt_id),0) INTO used;source_amount=receipt.amount;source_date=receipt.accounting_date;
 ELSIF NEW.payment_id IS NOT NULL THEN
  SELECT * INTO STRICT pay FROM supplier_payments WHERE company_id=NEW.company_id AND id=NEW.payment_id FOR UPDATE;
  IF i.kind<>'supplier' OR pay.supplier_id<>i.supplier_id OR pay.branch_id<>b.branch_id THEN RAISE EXCEPTION 'Opening payment contact/branch mismatch' USING ERRCODE='23514';END IF;
  SELECT coalesce((SELECT sum(amount) FROM supplier_allocations WHERE company_id=NEW.company_id AND payment_id=NEW.payment_id),0)+coalesce((SELECT sum(amount) FROM opening_allocations WHERE company_id=NEW.company_id AND payment_id=NEW.payment_id),0) INTO used;source_amount=pay.amount;source_date=pay.accounting_date;
 ELSE
  SELECT * INTO STRICT credit FROM advance_credits WHERE company_id=NEW.company_id AND id=NEW.credit_id FOR UPDATE;
  IF credit.branch_id<>b.branch_id OR credit.customer_id IS DISTINCT FROM i.customer_id OR credit.supplier_id IS DISTINCT FROM i.supplier_id THEN RAISE EXCEPTION 'Opening advance contact/branch mismatch' USING ERRCODE='23514';END IF;
  SELECT coalesce(sum(amount),0) INTO used FROM advance_uses WHERE company_id=NEW.company_id AND credit_id=credit.id AND target_type='opening_allocation' AND target_id=NEW.id;
  IF used<>NEW.amount THEN RAISE EXCEPTION 'Opening credit allocation must match exact advance consumption' USING ERRCODE='23514';END IF;
  source_amount=NEW.amount;used=0;source_date=credit.accounting_date;
 END IF;
 IF NEW.amount>source_amount-used OR NEW.accounting_date<source_date THEN RAISE EXCEPTION 'Opening allocation exceeds source or precedes it' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

-- An unused import stays reversible at its ORIGINAL cutover, but a batch whose
-- imported credits were already consumed is settled history, not a draft.
CREATE OR REPLACE FUNCTION guard_opening_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b opening_batches;entry opening_items;
BEGIN
 SELECT * INTO STRICT b FROM opening_batches WHERE company_id=NEW.company_id AND id=NEW.batch_id FOR UPDATE;
 IF b.status<>'posted' OR NEW.accounting_date<>b.accounting_date THEN RAISE EXCEPTION 'Unused opening reversal must use the original cutover date in an open period' USING ERRCODE='23514';END IF;
 FOR entry IN SELECT * FROM opening_items WHERE company_id=NEW.company_id AND batch_id=b.id ORDER BY kind,coalesce(customer_id,supplier_id),id LOOP
  IF entry.kind='customer' THEN PERFORM id FROM customers WHERE company_id=NEW.company_id AND id=entry.customer_id FOR UPDATE;ELSE PERFORM id FROM suppliers WHERE company_id=NEW.company_id AND id=entry.supplier_id FOR UPDATE;END IF;
  PERFORM id FROM opening_items WHERE company_id=NEW.company_id AND id=entry.id FOR UPDATE;
 END LOOP;
 PERFORM lock_opening_boundary(NEW.company_id,b.branch_id);
 IF EXISTS(SELECT 1 FROM opening_allocations a JOIN opening_items oi ON oi.company_id=a.company_id AND oi.id=a.item_id WHERE a.company_id=NEW.company_id AND oi.batch_id=b.id) THEN RAISE EXCEPTION 'Allocated opening balances cannot be reversed' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM advance_uses u JOIN advance_credits c ON c.company_id=u.company_id AND c.id=u.credit_id AND c.source_type='opening_balance' JOIN opening_items i ON i.company_id=c.company_id AND i.id=c.source_id WHERE u.company_id=NEW.company_id AND i.batch_id=b.id) THEN RAISE EXCEPTION 'Consumed opening credits cannot be reversed' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

-- Deferred source binding: an import/reversal cannot commit without a balanced
-- journal whose accounts stay within AR/AP/advances/equity and whose party
-- amounts match the imported items exactly per direction. No cash, stock,
-- revenue or tax can be posted by an opening source.
CREATE OR REPLACE FUNCTION opening_posting_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch uuid;source uuid;typ text;factor integer;b opening_batches;j journals;bad boolean;
BEGIN
 IF TG_TABLE_NAME='opening_batches' THEN IF NEW.status<>'posted' THEN RETURN NULL;END IF;batch=NEW.id;source=NEW.id;typ='opening_balance';factor=1;
 ELSE batch=NEW.batch_id;source=NEW.id;typ='opening_balance_reversal';factor=-1;END IF;
 SELECT * INTO STRICT b FROM opening_batches WHERE company_id=NEW.company_id AND id=batch;
 SELECT * INTO j FROM journals WHERE company_id=NEW.company_id AND source_type=typ AND source_id=source;
 IF j.id IS NULL OR j.branch_id<>b.branch_id OR j.accounting_date<>NEW.accounting_date THEN RAISE EXCEPTION 'Opening source journal missing or scope/date mismatch' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=NEW.company_id AND l.journal_id=j.id AND coalesce(a.system_key,'') NOT IN ('ar','ap','equity','customer_advances','supplier_advances')) THEN RAISE EXCEPTION 'Opening balances cannot post cash, stock, revenue or tax' USING ERRCODE='23514';END IF;
 WITH expected AS(
  SELECT CASE WHEN i.direction='debt' THEN CASE WHEN i.kind='customer' THEN 'ar' ELSE 'ap' END ELSE CASE WHEN i.kind='customer' THEN 'customer_advances' ELSE 'supplier_advances' END END AS scope,coalesce(i.customer_id,i.supplier_id) AS party,sum(i.amount)*factor AS amount
  FROM opening_items i WHERE i.company_id=NEW.company_id AND i.batch_id=batch GROUP BY 1,2
 ),actual AS(
  SELECT a.system_key AS scope,coalesce(l.customer_id,l.supplier_id) AS party,sum(CASE WHEN a.system_key IN('ar','supplier_advances') THEN l.debit-l.credit ELSE l.credit-l.debit END) AS amount
  FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
  WHERE l.company_id=NEW.company_id AND l.journal_id=j.id AND a.system_key IN('ar','ap','customer_advances','supplier_advances') GROUP BY 1,2
 )
 SELECT EXISTS(SELECT 1 FROM expected e FULL JOIN actual a USING(scope,party) WHERE coalesce(e.amount,0)<>coalesce(a.amount,0)) INTO bad;
 IF bad THEN RAISE EXCEPTION 'Opening party journal does not match imported items' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
