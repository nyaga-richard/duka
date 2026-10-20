-- Keep a serial tied to its actual batch/location, including transfers and returns.
ALTER TABLE stock_batches ADD CONSTRAINT stock_batches_location_identity UNIQUE(company_id,product_id,warehouse_id,id);
ALTER TABLE serial_numbers ADD COLUMN batch_id uuid;
DO $$
DECLARE tenant uuid;
BEGIN
 FOR tenant IN SELECT DISTINCT company_id FROM identities LOOP
  PERFORM set_config('app.company_id',tenant::text,true);
  UPDATE serial_numbers s SET batch_id=(
    SELECT m.batch_id FROM stock_movements m
    WHERE m.company_id=s.company_id AND m.product_id=s.product_id AND m.warehouse_id=s.warehouse_id
      AND m.serials ? s.serial AND m.batch_id IS NOT NULL
    ORDER BY m.created_at DESC,m.id DESC LIMIT 1
  );
  IF EXISTS(SELECT 1 FROM serial_numbers s JOIN products p ON p.company_id=s.company_id AND p.id=s.product_id WHERE p.batch_tracked AND s.batch_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot infer a legacy serial batch for tenant %. Reconcile tracking before migration 011.',tenant;
  END IF;
 END LOOP;
 PERFORM set_config('app.company_id','',true);
END $$;
ALTER TABLE serial_numbers ADD CONSTRAINT serial_batch_location_fk FOREIGN KEY(company_id,product_id,warehouse_id,batch_id) REFERENCES stock_batches(company_id,product_id,warehouse_id,id);
CREATE FUNCTION enforce_serial_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tracked boolean;
BEGIN
 SELECT batch_tracked INTO tracked FROM products WHERE company_id=NEW.company_id AND id=NEW.product_id;
 IF tracked IS DISTINCT FROM (NEW.batch_id IS NOT NULL) THEN RAISE EXCEPTION 'Serial batch must match product tracking policy'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER serial_batch_policy BEFORE INSERT OR UPDATE ON serial_numbers FOR EACH ROW EXECUTE FUNCTION enforce_serial_batch();
-- Serialize delivery-note creation through the source sale, then enforce at DB level.
CREATE UNIQUE INDEX delivery_note_once ON business_documents(company_id,sale_id) WHERE kind='delivery_note' AND status<>'cancelled';
-- Reconciliation history is evidence, not an editable balance override.
CREATE TRIGGER immutable_bank_reconciliation_lines BEFORE UPDATE OR DELETE ON bank_reconciliation_lines FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION protect_bank_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status='reconciled' THEN RAISE EXCEPTION 'A confirmed bank reconciliation is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_bank_reconciliation BEFORE UPDATE OR DELETE ON bank_reconciliations FOR EACH ROW EXECUTE FUNCTION protect_bank_reconciliation();
