-- Operational mail jobs are not financial history. Reset tokens and their mail
-- are committed atomically, delivered asynchronously, and purged from the body
-- immediately on success or once expired. Legacy development mail is never sent.
ALTER TABLE mail_outbox
 ADD COLUMN delivery_mode text NOT NULL DEFAULT 'outbox' CHECK(delivery_mode IN ('outbox','smtp')),
 ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN expires_at timestamptz,
 ADD COLUMN lease_token uuid,
 ADD COLUMN last_error text,
 ADD COLUMN sent_at timestamptz;
UPDATE mail_outbox SET expires_at=created_at+interval '30 minutes';
ALTER TABLE mail_outbox ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE mail_outbox ALTER COLUMN expires_at SET DEFAULT now()+interval '30 minutes';
ALTER TABLE mail_outbox ADD CONSTRAINT mail_delivery_status CHECK(status IN ('pending','processing','sent','failed','expired'));
CREATE INDEX mail_due ON mail_outbox(next_attempt_at) WHERE delivery_mode='smtp' AND status IN ('pending','processing');
CREATE INDEX mail_expiry ON mail_outbox(expires_at) WHERE status IN ('pending','processing','failed');
