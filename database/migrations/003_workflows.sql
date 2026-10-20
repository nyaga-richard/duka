ALTER TABLE sales ADD COLUMN customer_credit_used numeric(20,2) NOT NULL DEFAULT 0 CHECK(customer_credit_used>=0 AND customer_credit_used<=paid_at_sale);
ALTER TABLE sale_returns ADD COLUMN advance_credit numeric(20,2) NOT NULL DEFAULT 0 CHECK(advance_credit>=0);
ALTER TABLE sale_returns ADD COLUMN pending_refund numeric(20,2) NOT NULL DEFAULT 0 CHECK(pending_refund>=0);
ALTER TABLE sale_returns DROP CONSTRAINT sale_returns_check;
ALTER TABLE sale_returns ADD CONSTRAINT return_settlement CHECK(refund+credit_applied+advance_credit+pending_refund=total);
ALTER TABLE customer_allocations DROP CONSTRAINT customer_allocations_company_id_receipt_id_sale_id_key;
ALTER TABLE supplier_allocations DROP CONSTRAINT supplier_allocations_company_id_payment_id_invoice_id_key;
CREATE TABLE refund_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,return_id uuid NOT NULL,method_id uuid NOT NULL,amount numeric(20,2) NOT NULL CHECK(amount>0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitted','settled','failed')),provider_reference text,error text,created_by uuid NOT NULL,settled_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,provider_reference),
 FOREIGN KEY(company_id,return_id) REFERENCES sale_returns(company_id,id),FOREIGN KEY(company_id,method_id) REFERENCES payment_methods(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,settled_by) REFERENCES identities(company_id,id)
);
ALTER TABLE refund_requests ENABLE ROW LEVEL SECURITY;ALTER TABLE refund_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refund_requests USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
