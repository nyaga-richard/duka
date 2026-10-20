ALTER TABLE advance_credits ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX advance_fifo ON advance_credits(company_id,branch_id,accounting_date,created_at,id);
