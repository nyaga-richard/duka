-- Minimal pre-tenant dispatch maps used ONLY by the provider inbox; not exposed through CRUD APIs.
CREATE TABLE payment_dispatch (intent_id uuid PRIMARY KEY,company_id uuid NOT NULL REFERENCES companies(id),actor_id uuid NOT NULL REFERENCES identities(id),token_hash text NOT NULL UNIQUE,checkout_id text UNIQUE,claimed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE mock_provider_transactions (checkout_id text PRIMARY KEY,status text NOT NULL DEFAULT 'pending',receipt text,amount numeric(20,2) NOT NULL,phone text NOT NULL);
CREATE TABLE fiscal_dispatch (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),actor_id uuid NOT NULL REFERENCES identities(id),submission_id uuid NOT NULL UNIQUE,status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),last_error text);
CREATE INDEX fiscal_queue_ready ON fiscal_dispatch(status,next_attempt_at);
