-- Asset lifecycle (ordinary paid acquisition and final disposal) and pure
-- expense corrections (no-transfer void, account reclassification).
-- Every correction is append-only with its own immutable record, exact
-- DB guard and matching journal; original vouchers/payments are never edited.
-- NOTE: the account backfills below must run under the privileged migrator
-- role, never the restricted runtime role — FORCE RLS hides existing company
-- rows from the runtime role, which would silently backfill zero accounts.

-- Disposal outcome accounts for companies provisioned before this chart
-- version. Code fallbacks keep the unique company code rule when an operator
-- already created a custom account with the standard code.
INSERT INTO accounts(company_id,code,name,type,system_key)
 SELECT c.id,'4950','Gain on disposal of assets','income','asset_disposal_gain' FROM companies c
  WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.system_key='asset_disposal_gain')
   AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.code='4950');
INSERT INTO accounts(company_id,code,name,type,system_key)
 SELECT c.id,'4950A','Gain on disposal of assets','income','asset_disposal_gain' FROM companies c
  WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.system_key='asset_disposal_gain');
INSERT INTO accounts(company_id,code,name,type,system_key)
 SELECT c.id,'6300','Loss on disposal of assets','expense','asset_disposal_loss' FROM companies c
  WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.system_key='asset_disposal_loss')
   AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.code='6300');
INSERT INTO accounts(company_id,code,name,type,system_key)
 SELECT c.id,'6300A','Loss on disposal of assets','expense','asset_disposal_loss' FROM companies c
  WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.system_key='asset_disposal_loss');

-- A void keeps the voucher as history; it is visually and financially
-- terminal, not deleted. The 004 monetary immutability guard is widened by
-- exactly one permitted transition: a posted expense may only ever flip its
-- status to 'void', with every other column byte-identical.
ALTER TABLE expenses DROP CONSTRAINT expenses_status_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_status_check CHECK(status IN ('submitted','approved','rejected','posted','void'));
CREATE OR REPLACE FUNCTION expense_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='posted' AND NOT (NEW.status='void' AND (NEW.id,NEW.company_id,NEW.branch_id,NEW.category_id,NEW.supplier_id,NEW.number,NEW.description,NEW.net,NEW.tax,NEW.total,NEW.created_by,NEW.approved_by,NEW.approval_reason,NEW.accounting_date) IS NOT DISTINCT FROM (OLD.id,OLD.company_id,OLD.branch_id,OLD.category_id,OLD.supplier_id,OLD.number,OLD.description,OLD.net,OLD.tax,OLD.total,OLD.created_by,OLD.approved_by,OLD.approval_reason,OLD.accounting_date)) THEN RAISE EXCEPTION 'expense monetary fields are immutable' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'posted' AND (NEW.net,NEW.tax,NEW.total,NEW.branch_id,NEW.category_id,NEW.created_by,NEW.accounting_date,NEW.supplier_id) IS DISTINCT FROM (OLD.net,OLD.tax,OLD.total,OLD.branch_id,OLD.category_id,OLD.created_by,OLD.accounting_date,OLD.supplier_id) THEN RAISE EXCEPTION 'expense monetary fields are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;

-- Fixed assets grow an acquisition channel and a terminal disposal state.
ALTER TABLE fixed_assets ADD COLUMN funding text NOT NULL DEFAULT 'opening' CHECK(funding IN ('opening','payment'));
ALTER TABLE fixed_assets ADD COLUMN acquisition_tax numeric(20,2) NOT NULL DEFAULT 0 CHECK(acquisition_tax>=0);
ALTER TABLE fixed_assets ADD COLUMN acquisition_payment_id uuid;
ALTER TABLE fixed_assets ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disposed'));
ALTER TABLE fixed_assets ADD FOREIGN KEY(company_id,acquisition_payment_id) REFERENCES payments(company_id,id);
ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_funding_consistent CHECK((funding='opening' AND acquisition_payment_id IS NULL AND acquisition_tax=0) OR (funding='payment' AND acquisition_payment_id IS NOT NULL));
CREATE UNIQUE INDEX fixed_assets_acquisition_payment ON fixed_assets(company_id,acquisition_payment_id) WHERE acquisition_payment_id IS NOT NULL;

-- A paid acquisition must bind exactly one already-recorded real outgoing
-- tender of cost+tax on the same branch, tagged to this asset id.
CREATE FUNCTION guard_fixed_asset_acquisition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payments;
BEGIN
 IF NEW.funding<>'payment' THEN RETURN NEW;END IF;
 SELECT * INTO STRICT p FROM payments WHERE company_id=NEW.company_id AND id=NEW.acquisition_payment_id;
 IF p.direction<>'out' OR p.branch_id<>NEW.branch_id OR p.amount<>NEW.cost+NEW.acquisition_tax OR p.source_type<>'asset_acquisition' OR p.source_id<>NEW.id THEN
  RAISE EXCEPTION 'Paid asset acquisition must match its recorded outgoing tender' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fixed_asset_acquisition_guard BEFORE INSERT ON fixed_assets FOR EACH ROW EXECUTE FUNCTION guard_fixed_asset_acquisition();

-- The register row itself is source history: the only permitted change is
-- the terminal active -> disposed status flip. Deletes are never allowed.
CREATE FUNCTION guard_fixed_asset_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status=NEW.status AND OLD.funding IS NOT DISTINCT FROM NEW.funding THEN
  RAISE EXCEPTION 'Fixed asset register entries are immutable; dispose or correct via journals' USING ERRCODE='23514';END IF;
 IF NOT (OLD.status='active' AND NEW.status='disposed') THEN
  RAISE EXCEPTION 'Fixed asset status can only move active to disposed' USING ERRCODE='23514';END IF;
 IF OLD.id IS DISTINCT FROM NEW.id OR OLD.company_id IS DISTINCT FROM NEW.company_id OR OLD.branch_id IS DISTINCT FROM NEW.branch_id OR OLD.name IS DISTINCT FROM NEW.name OR OLD.cost IS DISTINCT FROM NEW.cost OR OLD.residual IS DISTINCT FROM NEW.residual OR OLD.useful_months IS DISTINCT FROM NEW.useful_months OR OLD.acquired_date IS DISTINCT FROM NEW.acquired_date OR OLD.asset_account_id IS DISTINCT FROM NEW.asset_account_id OR OLD.accumulated_account_id IS DISTINCT FROM NEW.accumulated_account_id OR OLD.expense_account_id IS DISTINCT FROM NEW.expense_account_id OR OLD.created_by IS DISTINCT FROM NEW.created_by OR OLD.funding IS DISTINCT FROM NEW.funding OR OLD.acquisition_tax IS DISTINCT FROM NEW.acquisition_tax OR OLD.acquisition_payment_id IS DISTINCT FROM NEW.acquisition_payment_id THEN
  RAISE EXCEPTION 'Disposal cannot rewrite asset register history' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fixed_asset_update_guard BEFORE UPDATE ON fixed_assets FOR EACH ROW EXECUTE FUNCTION guard_fixed_asset_update();
CREATE TRIGGER immutable_fixed_asset_delete BEFORE DELETE ON fixed_assets FOR EACH ROW EXECUTE FUNCTION immutable_record();

-- Depreciation stops exactly at disposal (full disposal only).
CREATE FUNCTION guard_depreciation_active() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
 SELECT status INTO STRICT s FROM fixed_assets WHERE company_id=NEW.company_id AND id=NEW.asset_id;
 IF s<>'active' THEN RAISE EXCEPTION 'Disposed assets cannot depreciate further' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER depreciation_active_guard BEFORE INSERT ON depreciation_runs FOR EACH ROW EXECUTE FUNCTION guard_depreciation_active();

CREATE TABLE asset_disposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,asset_id uuid NOT NULL,branch_id uuid NOT NULL,
 number text NOT NULL,proceeds numeric(20,2) NOT NULL CHECK(proceeds>=0),
 cost numeric(20,2) NOT NULL,accumulated numeric(20,2) NOT NULL,net_book_value numeric(20,2) NOT NULL,
 gain numeric(20,2) NOT NULL DEFAULT 0 CHECK(gain>=0),loss numeric(20,2) NOT NULL DEFAULT 0 CHECK(loss>=0),
 payment_id uuid,reason text NOT NULL CHECK(length(reason)>=5),accounting_date date NOT NULL,
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,number),UNIQUE(company_id,asset_id),UNIQUE(company_id,payment_id),
 FOREIGN KEY(company_id,asset_id) REFERENCES fixed_assets(company_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),
 FOREIGN KEY(company_id,payment_id) REFERENCES payments(company_id,id),
 FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),
 CHECK(gain=0 OR loss=0),CHECK((proceeds>0 AND payment_id IS NOT NULL) OR (proceeds=0 AND payment_id IS NULL))
);
ALTER TABLE asset_disposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_disposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_disposals USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
CREATE INDEX asset_disposals_parent ON asset_disposals(company_id,asset_id,accounting_date);

-- The DB recomputes every disposal figure from the register and run history;
-- a client may record proceeds and dates but never the accounting math.
CREATE FUNCTION guard_asset_disposal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a fixed_assets;acc numeric;nbv numeric;latest date;p payments;
BEGIN
 SELECT * INTO STRICT a FROM fixed_assets WHERE company_id=NEW.company_id AND id=NEW.asset_id FOR UPDATE;
 IF a.status<>'active' OR a.branch_id<>NEW.branch_id THEN RAISE EXCEPTION 'Asset disposal scope/status mismatch' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(amount),0) INTO acc FROM depreciation_runs WHERE company_id=NEW.company_id AND asset_id=a.id;
 nbv:=a.cost-acc;
 IF NEW.cost<>a.cost OR NEW.accumulated<>acc OR NEW.net_book_value<>nbv THEN RAISE EXCEPTION 'Disposal snapshot must match register cost/depreciation exactly' USING ERRCODE='23514';END IF;
 IF NEW.gain<>greatest(NEW.proceeds-nbv,0) OR NEW.loss<>greatest(nbv-NEW.proceeds,0) THEN RAISE EXCEPTION 'Disposal gain/loss must equal proceeds versus net book value' USING ERRCODE='23514';END IF;
 SELECT greatest(a.acquired_date,coalesce(max(j.accounting_date),a.acquired_date)) INTO latest FROM journals j JOIN depreciation_runs d ON d.company_id=j.company_id AND j.source_type='depreciation' AND j.source_id=d.id WHERE d.company_id=NEW.company_id AND d.asset_id=a.id;
 IF NEW.accounting_date<latest THEN RAISE EXCEPTION 'Disposal cannot precede acquisition/depreciation activity' USING ERRCODE='23514';END IF;
 IF NEW.proceeds>0 THEN
  SELECT * INTO STRICT p FROM payments WHERE company_id=NEW.company_id AND id=NEW.payment_id;
  IF p.direction<>'in' OR p.branch_id<>NEW.branch_id OR p.amount<>NEW.proceeds OR p.source_type<>'asset_disposal' OR p.source_id<>NEW.id THEN RAISE EXCEPTION 'Asset disposal proceeds must match their actual incoming tender' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_disposal_guard BEFORE INSERT ON asset_disposals FOR EACH ROW EXECUTE FUNCTION guard_asset_disposal();
CREATE TRIGGER immutable_asset_disposal BEFORE UPDATE OR DELETE ON asset_disposals FOR EACH ROW EXECUTE FUNCTION immutable_record();

-- Pure no-transfer voids of paid expense vouchers: the recorded tender was
-- erroneous, no cash/bank/M-Pesa movement ever happened. The original payment
-- row remains as audited history and is excluded from register balances; the
-- expense ledger deduction is withdrawn by an exact reversal at the original
-- posting date. A voucher with any actual refund history is real money and
-- can never be voided.
CREATE TABLE expense_voids (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,expense_id uuid NOT NULL,branch_id uuid NOT NULL,
 number text NOT NULL,payment_id uuid NOT NULL,net numeric(20,2) NOT NULL,tax numeric(20,2) NOT NULL,total numeric(20,2) NOT NULL,
 reason text NOT NULL CHECK(length(reason)>=5),accounting_date date NOT NULL,
 voided_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,number),UNIQUE(company_id,expense_id),UNIQUE(company_id,payment_id),
 FOREIGN KEY(company_id,expense_id) REFERENCES expenses(company_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),
 FOREIGN KEY(company_id,payment_id) REFERENCES payments(company_id,id),
 FOREIGN KEY(company_id,voided_by) REFERENCES identities(company_id,id),
 CHECK(net>=0 AND tax>=0 AND total>0 AND net+tax=total)
);
ALTER TABLE expense_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_voids FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_voids USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);

CREATE FUNCTION guard_expense_void() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e expenses;p payments;
BEGIN
 SELECT * INTO STRICT e FROM expenses WHERE company_id=NEW.company_id AND id=NEW.expense_id FOR UPDATE;
 IF e.status<>'posted' OR e.branch_id<>NEW.branch_id THEN RAISE EXCEPTION 'Expense void scope/status mismatch' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT p FROM payments WHERE company_id=NEW.company_id AND id=NEW.payment_id;
 IF p.direction<>'out' OR p.branch_id<>NEW.branch_id OR p.source_type<>'expense' OR p.source_id<>e.id OR p.amount<>e.total THEN RAISE EXCEPTION 'Expense void must bind the original recorded outgoing tender' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM expense_refunds r WHERE r.company_id=NEW.company_id AND r.expense_id=e.id) THEN RAISE EXCEPTION 'Expenses with actual refund history are real money and cannot be voided' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM expense_reclassifications r WHERE r.company_id=NEW.company_id AND r.expense_id=e.id) THEN RAISE EXCEPTION 'Reverse the reclassification completely before voiding' USING ERRCODE='23514';END IF;
 IF NEW.net<>e.net OR NEW.tax<>e.tax OR NEW.total<>e.total THEN RAISE EXCEPTION 'Void must snapshot the expense amounts exactly' USING ERRCODE='23514';END IF;
 IF NEW.accounting_date<>e.accounting_date THEN RAISE EXCEPTION 'Expense voids append at the original posting date only' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expense_void_guard BEFORE INSERT ON expense_voids FOR EACH ROW EXECUTE FUNCTION guard_expense_void();
CREATE TRIGGER immutable_expense_void BEFORE UPDATE OR DELETE ON expense_voids FOR EACH ROW EXECUTE FUNCTION immutable_record();

-- Account reclassification of a posted expense: moves part/all of the posted
-- net between expense accounts with zero effect on tax, totals, tenders or
-- net profit. Chained moves must first unwind to the original account.
CREATE TABLE expense_reclassifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,expense_id uuid NOT NULL,branch_id uuid NOT NULL,
 number text NOT NULL,from_account_id uuid NOT NULL,to_account_id uuid NOT NULL,amount numeric(20,2) NOT NULL CHECK(amount>0),
 reason text NOT NULL CHECK(length(reason)>=5),accounting_date date NOT NULL,
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,number),
 FOREIGN KEY(company_id,expense_id) REFERENCES expenses(company_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),
 FOREIGN KEY(company_id,from_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,to_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),
 CHECK(from_account_id<>to_account_id)
);
ALTER TABLE expense_reclassifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_reclassifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_reclassifications USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
CREATE INDEX expense_reclass_parent ON expense_reclassifications(company_id,expense_id,accounting_date);

CREATE FUNCTION guard_expense_reclassification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e expenses;original uuid;used numeric;posted_date date;latest date;
BEGIN
 SELECT * INTO STRICT e FROM expenses WHERE company_id=NEW.company_id AND id=NEW.expense_id FOR UPDATE;
 IF e.status<>'posted' OR e.branch_id<>NEW.branch_id THEN RAISE EXCEPTION 'Expense reclassification scope/status mismatch' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM expense_refunds r WHERE r.company_id=NEW.company_id AND r.expense_id=e.id) THEN RAISE EXCEPTION 'Expenses with actual refund history cannot be reclassified' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM expense_voids v WHERE v.company_id=NEW.company_id AND v.expense_id=e.id) THEN RAISE EXCEPTION 'Voided expenses cannot be reclassified' USING ERRCODE='23514';END IF;
 SELECT j.accounting_date,l.account_id INTO posted_date,original FROM journals j JOIN journal_lines l ON l.company_id=j.company_id AND l.journal_id=j.id JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE j.company_id=NEW.company_id AND j.source_type='expense' AND j.source_id=e.id AND a.type='expense' AND l.debit=e.net;
 IF original IS NULL OR posted_date IS NULL THEN RAISE EXCEPTION 'Expense has no original posting' USING ERRCODE='23514';END IF;
 IF NEW.from_account_id<>original THEN RAISE EXCEPTION 'Reclassification must start from the originally posted expense account' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(amount),0),greatest(posted_date,coalesce(max(accounting_date),posted_date)) INTO used,latest FROM expense_reclassifications WHERE company_id=NEW.company_id AND expense_id=e.id;
 IF NEW.amount>e.net-used THEN RAISE EXCEPTION 'Reclassification exceeds the remaining posted net' USING ERRCODE='23514';END IF;
 IF NEW.accounting_date<latest THEN RAISE EXCEPTION 'Reclassification cannot precede related posting activity' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=NEW.company_id AND a.id=NEW.to_account_id AND a.type='expense' AND a.active) THEN RAISE EXCEPTION 'Reclassification target must be an active expense account' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expense_reclassification_guard BEFORE INSERT ON expense_reclassifications FOR EACH ROW EXECUTE FUNCTION guard_expense_reclassification();
CREATE TRIGGER immutable_expense_reclassification BEFORE UPDATE OR DELETE ON expense_reclassifications FOR EACH ROW EXECUTE FUNCTION immutable_record();

-- Refunds are physical money flows: an expense whose classification is being
-- corrected is resolved through reclassification alone. The two correction
-- axes stay mutually exclusive so every account stays exactly reconciled.
CREATE OR REPLACE FUNCTION guard_expense_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e expenses;p payments;original expense_refunds;used_amount numeric;used_net numeric;used_tax numeric;posted_date date;latest_date date;
BEGIN
 SELECT * INTO STRICT e FROM expenses WHERE company_id=NEW.company_id AND id=NEW.expense_id FOR UPDATE;
 IF e.status<>'posted' OR e.branch_id<>NEW.branch_id THEN RAISE EXCEPTION 'Expense refund scope/status mismatch' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM expense_reclassifications r WHERE r.company_id=NEW.company_id AND r.expense_id=e.id) THEN RAISE EXCEPTION 'Reclassified expenses are corrected through reclassification, not refunds' USING ERRCODE='23514';END IF;
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
  IF original.kind<>'refund' OR original.expense_id<>e.id OR original.amount<>NEW.amount OR original.net<>NEW.net OR original.expense_id IS DISTINCT FROM NEW.expense_id OR original.expense_account_id<>NEW.expense_account_id OR original.tax_account_id IS DISTINCT FROM NEW.tax_account_id THEN RAISE EXCEPTION 'Invalid expense refund reversal' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO STRICT p FROM payments WHERE company_id=NEW.company_id AND id=NEW.payment_id;
 IF p.direction<>(CASE WHEN NEW.kind='refund' THEN 'in' ELSE 'out' END) OR p.branch_id<>NEW.branch_id OR p.amount<>NEW.amount OR p.source_type<>'expense_refund' OR p.source_id<>NEW.id THEN RAISE EXCEPTION 'Expense refund must match its actual tender direction/amount' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
