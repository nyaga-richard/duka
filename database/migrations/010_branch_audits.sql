ALTER TABLE audit_logs ADD COLUMN branch_id uuid;
ALTER TABLE audit_logs ADD FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id);
CREATE INDEX audit_branch ON audit_logs(company_id,branch_id,created_at DESC);
