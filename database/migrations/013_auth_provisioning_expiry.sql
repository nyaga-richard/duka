ALTER TABLE identities ADD COLUMN mfa_setup_expires_at timestamptz;
-- Unconfirmed legacy provisioning must be restarted with a fresh password check.
UPDATE identities SET mfa_secret=NULL WHERE NOT mfa_enabled;
