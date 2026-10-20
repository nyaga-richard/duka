ALTER TABLE customer_allocations ADD COLUMN accounting_date date NOT NULL DEFAULT coalesce(nullif(current_setting('app.accounting_date',true),'')::date,CURRENT_DATE);
ALTER TABLE supplier_allocations ADD COLUMN accounting_date date NOT NULL DEFAULT coalesce(nullif(current_setting('app.accounting_date',true),'')::date,CURRENT_DATE);
CREATE TABLE advance_credits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,customer_id uuid,supplier_id uuid,source_type text NOT NULL,source_id uuid NOT NULL,
 amount numeric(20,2) NOT NULL CHECK(amount>0),accounting_date date NOT NULL,created_by uuid NOT NULL,UNIQUE(company_id,id),UNIQUE(company_id,source_type,source_id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),CHECK(num_nonnulls(customer_id,supplier_id)=1)
);
CREATE TABLE advance_uses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,credit_id uuid NOT NULL,target_type text NOT NULL,target_id uuid NOT NULL,amount numeric(20,2) NOT NULL CHECK(amount>0),accounting_date date NOT NULL,
 UNIQUE(company_id,id),FOREIGN KEY(company_id,credit_id) REFERENCES advance_credits(company_id,id)
);
ALTER TABLE advance_credits ENABLE ROW LEVEL SECURITY;ALTER TABLE advance_credits FORCE ROW LEVEL SECURITY;
ALTER TABLE advance_uses ENABLE ROW LEVEL SECURITY;ALTER TABLE advance_uses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON advance_credits USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
CREATE POLICY tenant_isolation ON advance_uses USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
CREATE TRIGGER immutable_advance_credit BEFORE UPDATE OR DELETE ON advance_credits FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_advance_use BEFORE UPDATE OR DELETE ON advance_uses FOR EACH ROW EXECUTE FUNCTION immutable_record();
