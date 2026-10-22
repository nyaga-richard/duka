-- Queryable retail price-change tracking. The audit log already records each
-- update, but operators need a first-class screen to review who changed which
-- selling price, from what to what and why. Rows are append-only tenant data.
CREATE TABLE product_price_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  product_id uuid NOT NULL,
  old_price numeric(20,2) NOT NULL,
  new_price numeric(20,2) NOT NULL CHECK(new_price>=0),
  reason text NOT NULL,
  actor_id uuid NOT NULL REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id)
);
CREATE INDEX price_changes_product ON product_price_changes(company_id,product_id,created_at DESC);
ALTER TABLE product_price_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_price_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_price_changes USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
