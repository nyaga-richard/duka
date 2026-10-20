ALTER TABLE idempotency_keys ADD COLUMN actor_id uuid;
ALTER TABLE idempotency_keys ADD FOREIGN KEY(company_id,actor_id) REFERENCES identities(company_id,id);
