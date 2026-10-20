-- Positive legacy AR/AP outstanding items, not new sales, invoices, VAT, stock
-- or cash. Negative/advance imports require a separate explicit workflow.
CREATE TABLE opening_cutovers (
 company_id uuid NOT NULL,branch_id uuid NOT NULL,accounting_date date NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,branch_id),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id)
);
CREATE TABLE opening_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,number text NOT NULL,
 accounting_date date NOT NULL,reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 3 AND 160),notes text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','posted','cancelled')),
 created_by uuid NOT NULL,posted_by uuid,approval_reason text,created_at timestamptz NOT NULL DEFAULT now(),posted_at timestamptz,
 UNIQUE(company_id,id),UNIQUE(company_id,number),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,posted_by) REFERENCES identities(company_id,id),
 CHECK((status='posted' AND posted_by IS NOT NULL AND posted_at IS NOT NULL AND length(approval_reason)>=5) OR(status<>'posted' AND posted_by IS NULL AND posted_at IS NULL))
);
CREATE TABLE opening_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,batch_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('customer','supplier')),
 customer_id uuid,supplier_id uuid,reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 1 AND 120),reference_key text GENERATED ALWAYS AS(lower(btrim(reference))) STORED,
 original_date date,due_date date NOT NULL,amount numeric(20,2) NOT NULL CHECK(amount>0),description text NOT NULL DEFAULT '',
 UNIQUE(company_id,id),FOREIGN KEY(company_id,batch_id) REFERENCES opening_batches(company_id,id),FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),
 CHECK((kind='customer' AND customer_id IS NOT NULL AND supplier_id IS NULL) OR(kind='supplier' AND supplier_id IS NOT NULL AND customer_id IS NULL))
);
CREATE UNIQUE INDEX opening_item_reference ON opening_items(company_id,batch_id,kind,coalesce(customer_id,supplier_id),reference_key);
CREATE INDEX opening_item_contact ON opening_items(company_id,kind,customer_id,supplier_id);
CREATE TABLE opening_batch_reversals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,batch_id uuid NOT NULL,number text NOT NULL,accounting_date date NOT NULL,
 reason text NOT NULL CHECK(length(reason)>=5),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,batch_id),UNIQUE(company_id,number),FOREIGN KEY(company_id,batch_id) REFERENCES opening_batches(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id)
);
CREATE TABLE opening_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,item_id uuid NOT NULL,receipt_id uuid,payment_id uuid,credit_id uuid,
 amount numeric(20,2) NOT NULL CHECK(amount>0),accounting_date date NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),FOREIGN KEY(company_id,item_id) REFERENCES opening_items(company_id,id),FOREIGN KEY(company_id,receipt_id) REFERENCES customer_receipts(company_id,id),FOREIGN KEY(company_id,payment_id) REFERENCES supplier_payments(company_id,id),FOREIGN KEY(company_id,credit_id) REFERENCES advance_credits(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),
 CHECK(num_nonnulls(receipt_id,payment_id,credit_id)=1)
);
CREATE INDEX opening_alloc_parent ON opening_allocations(company_id,item_id,accounting_date);
CREATE INDEX opening_alloc_receipt ON opening_allocations(company_id,receipt_id);
CREATE INDEX opening_alloc_payment ON opening_allocations(company_id,payment_id);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['opening_cutovers','opening_batches','opening_items','opening_batch_reversals','opening_allocations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(company_id=nullif(current_setting(''app.company_id'',true),'''')::uuid) WITH CHECK(company_id=nullif(current_setting(''app.company_id'',true),'''')::uuid)',t);
END LOOP;END $$;
CREATE TRIGGER immutable_opening_cutover BEFORE UPDATE OR DELETE ON opening_cutovers FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_opening_reversal BEFORE UPDATE OR DELETE ON opening_batch_reversals FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_opening_allocation BEFORE UPDATE OR DELETE ON opening_allocations FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION lock_opening_boundary(tenant uuid,location uuid) RETURNS void LANGUAGE sql VOLATILE AS $$ SELECT pg_advisory_xact_lock(hashtextextended(tenant::text||':opening:'||location::text,0)) $$;
CREATE FUNCTION opening_item_balance(tenant uuid,item uuid,as_of date DEFAULT NULL) RETURNS numeric LANGUAGE sql VOLATILE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM opening_batch_reversals r WHERE r.company_id=tenant AND r.batch_id=b.id AND(as_of IS NULL OR r.accounting_date<=as_of)) THEN 0
 ELSE i.amount-coalesce((SELECT sum(a.amount) FROM opening_allocations a WHERE a.company_id=tenant AND a.item_id=item AND(as_of IS NULL OR a.accounting_date<=as_of)),0) END
 FROM opening_items i JOIN opening_batches b ON b.company_id=i.company_id AND b.id=i.batch_id
 WHERE i.company_id=tenant AND i.id=item AND b.status='posted' AND(as_of IS NULL OR b.accounting_date<=as_of)
$$;
CREATE FUNCTION guard_opening_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b opening_batches;
BEGIN
 SELECT * INTO STRICT b FROM opening_batches WHERE company_id=coalesce(NEW.company_id,OLD.company_id) AND id=coalesce(NEW.batch_id,OLD.batch_id) FOR UPDATE;
 IF b.status<>'draft' THEN RAISE EXCEPTION 'Opening items are immutable after submission' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND (NEW.company_id<>OLD.company_id OR NEW.batch_id<>OLD.batch_id OR NEW.id<>OLD.id) THEN RAISE EXCEPTION 'Opening item identity cannot change' USING ERRCODE='23514';END IF;
 IF TG_OP<>'DELETE' AND (NEW.original_date>b.accounting_date OR NEW.due_date<NEW.original_date) THEN RAISE EXCEPTION 'Invalid legacy document dates' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER opening_item_guard BEFORE INSERT OR UPDATE OR DELETE ON opening_items FOR EACH ROW EXECUTE FUNCTION guard_opening_item();
CREATE FUNCTION guard_opening_batch() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF EXISTS(SELECT 1 FROM opening_items i JOIN opening_items p ON p.company_id=i.company_id AND p.kind=i.kind AND coalesce(p.customer_id,p.supplier_id)=coalesce(i.customer_id,i.supplier_id) AND p.reference_key=i.reference_key AND p.batch_id<>i.batch_id JOIN opening_batches b ON b.company_id=p.company_id AND b.id=p.batch_id WHERE i.company_id=NEW.company_id AND i.batch_id=NEW.id AND b.branch_id=NEW.branch_id AND b.status='posted' AND NOT EXISTS(SELECT 1 FROM opening_batch_reversals r WHERE r.company_id=b.company_id AND r.batch_id=b.id)) THEN RAISE EXCEPTION 'Legacy opening reference already imported' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM opening_items i JOIN supplier_invoices p ON p.company_id=i.company_id AND p.supplier_id=i.supplier_id AND lower(btrim(p.supplier_reference))=i.reference_key WHERE i.company_id=NEW.company_id AND i.batch_id=NEW.id AND i.kind='supplier') THEN RAISE EXCEPTION 'Supplier invoice already exists in the operational ledger' USING ERRCODE='23514';END IF;
  INSERT INTO opening_cutovers(company_id,branch_id,accounting_date,created_by) VALUES(NEW.company_id,NEW.branch_id,NEW.accounting_date,NEW.posted_by) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER opening_batch_guard BEFORE INSERT OR UPDATE OR DELETE ON opening_batches FOR EACH ROW EXECUTE FUNCTION guard_opening_batch();
CREATE FUNCTION guard_opening_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b opening_batches;i opening_items;
BEGIN
 SELECT * INTO STRICT b FROM opening_batches WHERE company_id=NEW.company_id AND id=NEW.batch_id FOR UPDATE;
 IF b.status<>'posted' OR NEW.accounting_date<b.accounting_date THEN RAISE EXCEPTION 'Invalid opening reversal status/date' USING ERRCODE='23514';END IF;
 FOR i IN SELECT * FROM opening_items WHERE company_id=NEW.company_id AND batch_id=b.id ORDER BY kind,coalesce(customer_id,supplier_id),id LOOP
  IF i.kind='customer' THEN PERFORM id FROM customers WHERE company_id=NEW.company_id AND id=i.customer_id FOR UPDATE;ELSE PERFORM id FROM suppliers WHERE company_id=NEW.company_id AND id=i.supplier_id FOR UPDATE;END IF;
  PERFORM id FROM opening_items WHERE company_id=NEW.company_id AND id=i.id FOR UPDATE;
 END LOOP;
 PERFORM lock_opening_boundary(NEW.company_id,b.branch_id);
 IF EXISTS(SELECT 1 FROM opening_allocations a JOIN opening_items i ON i.company_id=a.company_id AND i.id=a.item_id WHERE a.company_id=NEW.company_id AND i.batch_id=b.id) THEN RAISE EXCEPTION 'Allocated opening balances cannot be reversed' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER opening_reversal_guard BEFORE INSERT ON opening_batch_reversals FOR EACH ROW EXECUTE FUNCTION guard_opening_reversal();
CREATE FUNCTION guard_opening_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i opening_items;b opening_batches;receipt customer_receipts;pay supplier_payments;credit advance_credits;used numeric;source_amount numeric;source_date date;last_date date;
BEGIN
 SELECT * INTO STRICT i FROM opening_items WHERE company_id=NEW.company_id AND id=NEW.item_id;
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
CREATE TRIGGER opening_alloc_guard BEFORE INSERT ON opening_allocations FOR EACH ROW EXECUTE FUNCTION guard_opening_allocation();
CREATE FUNCTION enforce_opening_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c date;
BEGIN
 IF NEW.source_type IN ('sale','sale_return','customer_receipt','supplier_invoice','supplier_payment','supplier_return','supplier_credit_settlement','advance_allocation','opening_allocation') THEN
  PERFORM lock_opening_boundary(NEW.company_id,NEW.branch_id);
  SELECT accounting_date INTO c FROM opening_cutovers WHERE company_id=NEW.company_id AND branch_id=NEW.branch_id;
  IF c IS NOT NULL AND NEW.accounting_date<=c THEN RAISE EXCEPTION 'Debt activity must be after the branch opening cutover date' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER opening_boundary_journal BEFORE INSERT ON journals FOR EACH ROW EXECUTE FUNCTION enforce_opening_boundary();
CREATE FUNCTION guard_opening_supplier_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM suppliers WHERE company_id=NEW.company_id AND id=NEW.supplier_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM opening_items i JOIN opening_batches b ON b.company_id=i.company_id AND b.id=i.batch_id WHERE i.company_id=NEW.company_id AND i.supplier_id=NEW.supplier_id AND i.reference_key=lower(btrim(NEW.supplier_reference)) AND b.status='posted' AND NOT EXISTS(SELECT 1 FROM opening_batch_reversals r WHERE r.company_id=b.company_id AND r.batch_id=b.id)) THEN RAISE EXCEPTION 'Supplier legacy reference already imported as an opening payable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER opening_supplier_reference BEFORE INSERT ON supplier_invoices FOR EACH ROW EXECUTE FUNCTION guard_opening_supplier_reference();
-- Deferred source binding: an import/reversal cannot commit without its balanced
-- AR/AP/equity-only journal and exact party dimensions. No tax, cash or revenue.
CREATE FUNCTION opening_posting_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch uuid;source uuid;typ text;factor integer;b opening_batches;j journals;bad boolean;
BEGIN
 IF TG_TABLE_NAME='opening_batches' THEN IF NEW.status<>'posted' THEN RETURN NULL;END IF;batch=NEW.id;source=NEW.id;typ='opening_balance';factor=1;
 ELSE batch=NEW.batch_id;source=NEW.id;typ='opening_balance_reversal';factor=-1;END IF;
 SELECT * INTO STRICT b FROM opening_batches WHERE company_id=NEW.company_id AND id=batch;
 SELECT * INTO j FROM journals WHERE company_id=NEW.company_id AND source_type=typ AND source_id=source;
 IF j.id IS NULL OR j.branch_id<>b.branch_id OR j.accounting_date<>NEW.accounting_date THEN RAISE EXCEPTION 'Opening source journal missing or scope/date mismatch' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=NEW.company_id AND l.journal_id=j.id AND coalesce(a.system_key,'') NOT IN ('ar','ap','equity')) THEN RAISE EXCEPTION 'Opening balances cannot post cash, stock, revenue or tax' USING ERRCODE='23514';END IF;
 WITH expected AS(SELECT kind,coalesce(customer_id,supplier_id) AS party,sum(amount)*factor AS amount FROM opening_items WHERE company_id=NEW.company_id AND batch_id=batch GROUP BY kind,coalesce(customer_id,supplier_id)),actual AS(SELECT CASE WHEN a.system_key='ar' THEN 'customer' ELSE 'supplier' END AS kind,CASE WHEN a.system_key='ar' THEN l.customer_id ELSE l.supplier_id END AS party,sum(CASE WHEN a.system_key='ar' THEN l.debit-l.credit ELSE l.credit-l.debit END) AS amount FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=NEW.company_id AND l.journal_id=j.id AND a.system_key IN ('ar','ap') GROUP BY a.system_key,l.customer_id,l.supplier_id)
 SELECT EXISTS(SELECT 1 FROM expected e FULL JOIN actual a USING(kind,party) WHERE coalesce(e.amount,0)<>coalesce(a.amount,0)) INTO bad;
 IF bad THEN RAISE EXCEPTION 'Opening AR/AP party journal does not match imported items' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER opening_post_complete AFTER INSERT OR UPDATE ON opening_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opening_posting_complete();
CREATE CONSTRAINT TRIGGER opening_reverse_complete AFTER INSERT ON opening_batch_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opening_posting_complete();
