-- Forward correction: disambiguate PL/pgSQL record from SQL item aliases.
CREATE OR REPLACE FUNCTION guard_opening_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b opening_batches;entry opening_items;
BEGIN
 SELECT * INTO STRICT b FROM opening_batches WHERE company_id=NEW.company_id AND id=NEW.batch_id FOR UPDATE;
 IF b.status<>'posted' OR NEW.accounting_date<b.accounting_date THEN RAISE EXCEPTION 'Invalid opening reversal status/date' USING ERRCODE='23514';END IF;
 FOR entry IN SELECT * FROM opening_items WHERE company_id=NEW.company_id AND batch_id=b.id ORDER BY kind,coalesce(customer_id,supplier_id),id LOOP
  IF entry.kind='customer' THEN PERFORM id FROM customers WHERE company_id=NEW.company_id AND id=entry.customer_id FOR UPDATE;ELSE PERFORM id FROM suppliers WHERE company_id=NEW.company_id AND id=entry.supplier_id FOR UPDATE;END IF;
  PERFORM id FROM opening_items WHERE company_id=NEW.company_id AND id=entry.id FOR UPDATE;
 END LOOP;
 PERFORM lock_opening_boundary(NEW.company_id,b.branch_id);
 IF EXISTS(SELECT 1 FROM opening_allocations a JOIN opening_items oi ON oi.company_id=a.company_id AND oi.id=a.item_id WHERE a.company_id=NEW.company_id AND oi.batch_id=b.id) THEN RAISE EXCEPTION 'Allocated opening balances cannot be reversed' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
