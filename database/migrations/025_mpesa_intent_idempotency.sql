-- Client-generated idempotency keys for M-Pesa STK initiation, so retries,
-- double taps and resubmits can never fire a second push for the same request.
ALTER TABLE payment_intents ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX payment_intents_idempotency_key ON payment_intents(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
