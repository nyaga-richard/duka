-- Supplier trade terms (credit limit + trade discount master data) and
-- encrypted per-company integration credentials. Integration secrets live
-- ONLY as AES-256-GCM ciphertext written by the application under the
-- deployment's MFA_ENCRYPTION_KEY; this table never stores plaintext and the
-- service layer never returns stored values — configuration presence is the
-- only readable signal. Tenant isolation uses the database RLS policy below.

ALTER TABLE suppliers ADD COLUMN credit_limit numeric(20,2) NOT NULL DEFAULT 0 CHECK(credit_limit>=0);
ALTER TABLE suppliers ADD COLUMN discount_percent numeric(9,6) NOT NULL DEFAULT 0 CHECK(discount_percent BETWEEN 0 AND 100);

CREATE TABLE integration_settings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 provider text NOT NULL CHECK(provider IN ('mpesa','etims')),
 enabled boolean NOT NULL DEFAULT false,
 ciphertext bytea NOT NULL,
 iv bytea NOT NULL,
 auth_tag bytea NOT NULL,
 updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,provider)
);
CREATE INDEX integration_settings_revisions ON integration_settings(company_id,updated_at DESC);

-- recorded operator updates only; rows are never deleted so configuration
-- history stays auditable (deactivation is an update flipping enabled).
CREATE RULE integration_settings_no_delete AS ON DELETE TO integration_settings DO NOTHING;

ALTER TABLE integration_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_settings
 USING (company_id=nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id=nullif(current_setting('app.company_id',true),'')::uuid);
