-- Actual refunds of paid expense vouchers, and actual outgoing repayments of
-- those refunds. These are NOT cancellations of an external bank/M-Pesa transfer.
-- Original vouchers, tenders and posted journals remain immutable.
CREATE TABLE expense_refunds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,expense_id uuid NOT NULL,branch_id uuid NOT NULL,
 number text NOT NULL,kind text NOT NULL CHECK(kind IN ('refund','reversal')),reversal_of uuid,
 amount numeric(20,2) NOT NULL CHECK(amount>0),net numeric(20,2) NOT NULL CHECK(net>=0),tax numeric(20,2) NOT NULL CHECK(tax>=0),
 expense_account_id uuid NOT NULL,tax_account_id uuid,payment_id uuid NOT NULL,accounting_date date NOT NULL,
 reason text NOT NULL CHECK(length(reason)>=5),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,number),UNIQUE(company_id,payment_id),UNIQUE(company_id,reversal_of),
 FOREIGN KEY(company_id,expense_id) REFERENCES expenses(company_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),
 FOREIGN KEY(company_id,expense_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,tax_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,payment_id) REFERENCES payments(company_id,id),
 FOREIGN KEY(company_id,reversal_of) REFERENCES expense_refunds(company_id,id),
 FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),
 CHECK(net+tax=amount),CHECK((kind='refund' AND reversal_of IS NULL) OR(kind='reversal' AND reversal_of IS NOT NULL)),CHECK(tax=0 OR tax_account_id IS NOT NULL)
);
ALTER TABLE expense_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_refunds USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
CREATE INDEX expense_refunds_parent ON expense_refunds(company_id,expense_id,accounting_date);
CREATE FUNCTION guard_expense_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e expenses;p payments;original expense_refunds;used_amount numeric;used_net numeric;used_tax numeric;posted_date date;latest_date date;
BEGIN
 SELECT * INTO STRICT e FROM expenses WHERE company_id=NEW.company_id AND id=NEW.expense_id FOR UPDATE;
 IF e.status<>'posted' OR e.branch_id<>NEW.branch_id THEN RAISE EXCEPTION 'Expense refund scope/status mismatch' USING ERRCODE='23514';END IF;
 SELECT max(accounting_date) INTO posted_date FROM journals WHERE company_id=NEW.company_id AND source_type='expense' AND source_id=e.id;
 IF posted_date IS NULL THEN RAISE EXCEPTION 'Expense has no original posting' USING ERRCODE='23514';END IF;
 SELECT greatest(posted_date,e.accounting_date,max(accounting_date)) INTO latest_date FROM expense_refunds WHERE company_id=NEW.company_id AND expense_id=e.id;
 IF NEW.accounting_date<latest_date THEN RAISE EXCEPTION 'Expense refund cannot precede related posting/refund activity' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM journals j JOIN journal_lines l ON l.company_id=j.company_id AND l.journal_id=j.id JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE j.company_id=NEW.company_id AND j.source_type='expense' AND j.source_id=e.id AND l.account_id=NEW.expense_account_id AND a.type='expense' AND l.debit=e.net) THEN RAISE EXCEPTION 'Refund must use original posted expense account' USING ERRCODE='23514';END IF;
 IF NEW.tax>0 AND NOT EXISTS(SELECT 1 FROM journals j JOIN journal_lines l ON l.company_id=j.company_id AND l.journal_id=j.id JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE j.company_id=NEW.company_id AND j.source_type='expense' AND j.source_id=e.id AND l.account_id=NEW.tax_account_id AND a.system_key='tax_input' AND l.debit=e.tax) THEN RAISE EXCEPTION 'Refund must use original posted tax account' USING ERRCODE='23514';END IF;
 IF NEW.kind='refund' THEN
  SELECT coalesce(sum(CASE WHEN kind='refund' THEN amount ELSE -amount END),0),coalesce(sum(CASE WHEN kind='refund' THEN net ELSE -net END),0),coalesce(sum(CASE WHEN kind='refund' THEN tax ELSE -tax END),0) INTO used_amount,used_net,used_tax FROM expense_refunds WHERE company_id=NEW.company_id AND expense_id=e.id;
  IF NEW.amount>e.total-used_amount OR NEW.net>e.net-used_net OR NEW.tax>e.tax-used_tax THEN RAISE EXCEPTION 'Expense refund exceeds remaining paid/net/tax balance' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO STRICT original FROM expense_refunds WHERE company_id=NEW.company_id AND id=NEW.reversal_of FOR UPDATE;
  IF original.kind<>'refund' OR original.expense_id<>e.id OR original.amount<>NEW.amount OR original.net<>NEW.net OR original.tax<>NEW.tax OR original.expense_account_id<>NEW.expense_account_id OR original.tax_account_id IS DISTINCT FROM NEW.tax_account_id THEN RAISE EXCEPTION 'Invalid expense refund reversal' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO STRICT p FROM payments WHERE company_id=NEW.company_id AND id=NEW.payment_id;
 IF p.direction<>(CASE WHEN NEW.kind='refund' THEN 'in' ELSE 'out' END) OR p.branch_id<>NEW.branch_id OR p.amount<>NEW.amount OR p.source_type<>'expense_refund' OR p.source_id<>NEW.id THEN RAISE EXCEPTION 'Expense refund must match its actual tender direction/amount' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expense_refund_guard BEFORE INSERT ON expense_refunds FOR EACH ROW EXECUTE FUNCTION guard_expense_refund();
CREATE TRIGGER immutable_expense_refund BEFORE UPDATE OR DELETE ON expense_refunds FOR EACH ROW EXECUTE FUNCTION immutable_record();
