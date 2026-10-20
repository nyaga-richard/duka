-- Append-only reuse/refund of an AP debit balance. Original invoices, payments
-- and supplier returns are never edited or retrospectively reclassified.
CREATE TABLE supplier_credit_settlements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,
 branch_id uuid NOT NULL,supplier_id uuid NOT NULL,from_invoice_id uuid NOT NULL,to_invoice_id uuid,
 kind text NOT NULL CHECK(kind IN ('offset','refund','reversal')),number text NOT NULL,amount numeric(20,2) NOT NULL CHECK(amount>0),
 payment_id uuid,reversal_of uuid,accounting_date date NOT NULL,reason text NOT NULL CHECK(length(reason)>=5),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,number),UNIQUE(company_id,payment_id),UNIQUE(company_id,reversal_of),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),
 FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),
 FOREIGN KEY(company_id,from_invoice_id) REFERENCES supplier_invoices(company_id,id),
 FOREIGN KEY(company_id,to_invoice_id) REFERENCES supplier_invoices(company_id,id),
 FOREIGN KEY(company_id,payment_id) REFERENCES payments(company_id,id),
 FOREIGN KEY(company_id,reversal_of) REFERENCES supplier_credit_settlements(company_id,id),
 FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),
 CHECK((kind='offset' AND to_invoice_id IS NOT NULL AND payment_id IS NULL AND from_invoice_id<>to_invoice_id AND reversal_of IS NULL) OR (kind='refund' AND to_invoice_id IS NULL AND payment_id IS NOT NULL AND reversal_of IS NULL) OR(kind='reversal' AND reversal_of IS NOT NULL))
);
ALTER TABLE supplier_credit_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supplier_credit_settlements USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
CREATE INDEX supplier_credit_from ON supplier_credit_settlements(company_id,from_invoice_id,accounting_date);
CREATE INDEX supplier_credit_to ON supplier_credit_settlements(company_id,to_invoice_id,accounting_date);
CREATE INDEX supplier_allocations_invoice_date ON supplier_allocations(company_id,invoice_id,accounting_date);
CREATE INDEX supplier_returns_invoice_date ON supplier_returns(company_id,invoice_id,accounting_date);
CREATE FUNCTION supplier_invoice_balance(tenant uuid,invoice uuid,as_of date DEFAULT NULL) RETURNS numeric LANGUAGE sql VOLATILE AS $$
 SELECT i.total
 -coalesce((SELECT sum(a.amount) FROM supplier_allocations a WHERE a.company_id=tenant AND a.invoice_id=invoice AND (as_of IS NULL OR a.accounting_date<=as_of)),0)
 -coalesce((SELECT sum(r.total) FROM supplier_returns r WHERE r.company_id=tenant AND r.invoice_id=invoice AND (as_of IS NULL OR r.accounting_date<=as_of)),0)
 +coalesce((SELECT sum(CASE WHEN c.kind='reversal' THEN -c.amount ELSE c.amount END) FROM supplier_credit_settlements c WHERE c.company_id=tenant AND c.from_invoice_id=invoice AND (as_of IS NULL OR c.accounting_date<=as_of)),0)
 -coalesce((SELECT sum(CASE WHEN c.kind='reversal' THEN -c.amount ELSE c.amount END) FROM supplier_credit_settlements c WHERE c.company_id=tenant AND c.to_invoice_id=invoice AND (as_of IS NULL OR c.accounting_date<=as_of)),0)
 FROM supplier_invoices i WHERE i.company_id=tenant AND i.id=invoice AND (as_of IS NULL OR i.accounting_date<=as_of)
$$;
-- VOLATILE is intentional: BEFORE INSERT guards see earlier rows of a multi-row
-- command, not a stale statement snapshot. Reports run repeatable-read.
CREATE FUNCTION guard_supplier_credit_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src supplier_invoices;target supplier_invoices;p payments;original supplier_credit_settlements;available numeric;latest date;
BEGIN
 PERFORM id FROM suppliers WHERE company_id=NEW.company_id AND id=NEW.supplier_id FOR UPDATE;
 PERFORM id FROM supplier_invoices WHERE company_id=NEW.company_id AND id IN(NEW.from_invoice_id,NEW.to_invoice_id) ORDER BY id FOR UPDATE;
 SELECT * INTO STRICT src FROM supplier_invoices WHERE company_id=NEW.company_id AND id=NEW.from_invoice_id;
 IF src.branch_id<>NEW.branch_id OR src.supplier_id<>NEW.supplier_id THEN RAISE EXCEPTION 'Supplier credit scope mismatch' USING ERRCODE='23514';END IF;
 SELECT max(d) INTO latest FROM (
 SELECT accounting_date AS d FROM supplier_invoices WHERE company_id=NEW.company_id AND id IN(NEW.from_invoice_id,NEW.to_invoice_id)
 UNION ALL SELECT accounting_date FROM supplier_allocations WHERE company_id=NEW.company_id AND invoice_id IN(NEW.from_invoice_id,NEW.to_invoice_id)
 UNION ALL SELECT accounting_date FROM supplier_returns WHERE company_id=NEW.company_id AND invoice_id IN(NEW.from_invoice_id,NEW.to_invoice_id)
 UNION ALL SELECT accounting_date FROM supplier_credit_settlements WHERE company_id=NEW.company_id AND (from_invoice_id IN(NEW.from_invoice_id,NEW.to_invoice_id) OR to_invoice_id IN(NEW.from_invoice_id,NEW.to_invoice_id))
 ) e;
 IF NEW.accounting_date<latest THEN RAISE EXCEPTION 'Supplier credit cannot precede related document activity' USING ERRCODE='23514';END IF;
 IF NEW.kind='reversal' THEN
  SELECT * INTO STRICT original FROM supplier_credit_settlements WHERE company_id=NEW.company_id AND id=NEW.reversal_of FOR UPDATE;
  IF original.kind='reversal' OR original.amount<>NEW.amount OR original.from_invoice_id<>NEW.from_invoice_id OR original.to_invoice_id IS DISTINCT FROM NEW.to_invoice_id OR original.branch_id<>NEW.branch_id OR original.supplier_id<>NEW.supplier_id THEN RAISE EXCEPTION 'Invalid supplier credit reversal' USING ERRCODE='23514';END IF;
  IF original.kind='offset' AND NEW.payment_id IS NOT NULL THEN RAISE EXCEPTION 'Offset reversal cannot move cash' USING ERRCODE='23514';END IF;
  IF original.kind='refund' THEN
   SELECT * INTO STRICT p FROM payments WHERE company_id=NEW.company_id AND id=NEW.payment_id;
   IF p.direction<>'out' OR p.branch_id<>NEW.branch_id OR p.amount<>NEW.amount OR p.source_type<>'supplier_credit_settlement' OR p.source_id<>NEW.id THEN RAISE EXCEPTION 'Refund reversal requires its actual outgoing payment' USING ERRCODE='23514';END IF;
  END IF;
  RETURN NEW;
 END IF;
 available=-supplier_invoice_balance(NEW.company_id,NEW.from_invoice_id);
 IF available IS NULL OR NEW.amount>available THEN RAISE EXCEPTION 'Supplier credit exceeds available balance' USING ERRCODE='23514';END IF;
 IF NEW.kind='offset' THEN
  SELECT * INTO STRICT target FROM supplier_invoices WHERE company_id=NEW.company_id AND id=NEW.to_invoice_id;
  IF target.branch_id<>NEW.branch_id OR target.supplier_id<>NEW.supplier_id OR NEW.amount>supplier_invoice_balance(NEW.company_id,NEW.to_invoice_id) THEN RAISE EXCEPTION 'Supplier credit target mismatch or over-allocation' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO STRICT p FROM payments WHERE company_id=NEW.company_id AND id=NEW.payment_id;
  IF p.direction<>'in' OR p.branch_id<>NEW.branch_id OR p.amount<>NEW.amount OR p.source_type<>'supplier_credit_settlement' OR p.source_id<>NEW.id THEN RAISE EXCEPTION 'Supplier credit refund must match an incoming payment' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER supplier_credit_guard BEFORE INSERT ON supplier_credit_settlements FOR EACH ROW EXECUTE FUNCTION guard_supplier_credit_settlement();
CREATE TRIGGER immutable_supplier_credit BEFORE UPDATE OR DELETE ON supplier_credit_settlements FOR EACH ROW EXECUTE FUNCTION immutable_record();
