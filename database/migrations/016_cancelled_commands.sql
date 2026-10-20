-- Old responses are retained, but legacy replays require resource reconciliation:
-- no historical authorization scope is invented or backfilled.
ALTER TABLE idempotency_keys ADD COLUMN authorization_scope text;
-- A committed tombstone makes it safe to abandon an UNPOSTED uncertain checkout:
-- the original command and cancellation share one advisory lock. A delayed old
-- packet can never post after cancellation. Posted sales are never cancelled here.
CREATE TABLE cancelled_commands (
 company_id uuid NOT NULL,operation text NOT NULL CHECK(operation='post:/sales'),key text NOT NULL CHECK(length(key) BETWEEN 8 AND 160),
 actor_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason)>=5),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,operation,key),FOREIGN KEY(company_id,actor_id) REFERENCES identities(company_id,id)
);
ALTER TABLE cancelled_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancelled_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cancelled_commands USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid AND actor_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE TRIGGER immutable_cancelled_command BEFORE UPDATE OR DELETE ON cancelled_commands FOR EACH ROW EXECUTE FUNCTION immutable_record();
-- Defense even for a delayed older writer that does its financial work before
-- inserting the idempotent result: this exception rolls back the entire posting.
CREATE FUNCTION reject_cancelled_checkout_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.operation='post:/sales' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text||':'||NEW.operation||':'||NEW.key,0));
  IF EXISTS(SELECT 1 FROM cancelled_commands WHERE company_id=NEW.company_id AND operation=NEW.operation AND key=NEW.key) THEN RAISE EXCEPTION 'Checkout was cancelled before posting' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reject_cancelled_checkout BEFORE INSERT ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION reject_cancelled_checkout_result();
