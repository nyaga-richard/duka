-- Stock carries an explicit business date in addition to immutable capture time.
ALTER TABLE stock_movements ADD COLUMN accounting_date date NOT NULL DEFAULT coalesce(nullif(current_setting('app.accounting_date',true),'')::date,CURRENT_DATE);
CREATE INDEX stock_accounting_dates ON stock_movements(company_id,accounting_date,warehouse_id);
-- Approval/accounting consistency: expense monetary fields cannot change after creation.
CREATE FUNCTION expense_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='posted' OR (NEW.net,NEW.tax,NEW.total,NEW.branch_id,NEW.category_id,NEW.created_by,NEW.accounting_date,NEW.supplier_id) IS DISTINCT FROM (OLD.net,OLD.tax,OLD.total,OLD.branch_id,OLD.category_id,OLD.created_by,OLD.accounting_date,OLD.supplier_id) THEN RAISE EXCEPTION 'expense monetary fields are immutable' USING ERRCODE='23514'; END IF;RETURN NEW; END $$;
CREATE TRIGGER expense_financial_guard BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION expense_guard();
