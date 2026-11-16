-- =============================================================================
-- 0005 ERP integration, idempotency, audit and background-job plumbing.
--
-- The ERP is reached only through its documented HTTP API (see
-- docs/ERP_INTEGRATION_CAPABILITY_REPORT.md). These tables are the local
-- bookkeeping that makes that integration retry-safe and auditable.
-- =============================================================================

CREATE TABLE "erp_entity_map" (
  "map_id" bigserial PRIMARY KEY,
  "entity_type" varchar(30) NOT NULL CHECK ("entity_type" IN (
    'brand', 'category', 'product', 'variant', 'customer', 'order',
    'payment', 'refund', 'shipment', 'branch', 'warehouse', 'payment_method',
    'tax_rule', 'unit'
  )),
  "local_id" varchar(64) NOT NULL,
  "erp_id" varchar(64) NOT NULL,
  "erp_company_id" varchar(64),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_synced_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("entity_type", "local_id"),
  UNIQUE ("entity_type", "erp_id"),
  CHECK (length("local_id") > 0 AND length("erp_id") > 0)
);
CREATE INDEX idx_erp_map_entity ON "erp_entity_map" ("entity_type", "last_synced_at" DESC);

CREATE TABLE "erp_sync_log" (
  "log_id" bigserial PRIMARY KEY,
  "entity_type" varchar(30) NOT NULL,
  "direction" varchar(10) NOT NULL CHECK ("direction" IN ('pull', 'push')),
  "operation" varchar(80) NOT NULL,
  "idempotency_key" varchar(160) NOT NULL UNIQUE,
  "status" varchar(20) NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending', 'in_progress', 'succeeded', 'failed', 'skipped')),
  "attempts" int NOT NULL DEFAULT 0,
  "http_status" int,
  "request_summary" jsonb,
  "response_summary" jsonb,
  "error_code" varchar(80),
  "error_message" varchar(500),
  "correlation_id" varchar(80),
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz
);
CREATE INDEX idx_sync_log_status ON "erp_sync_log" ("status", "started_at" DESC);
CREATE INDEX idx_sync_log_entity ON "erp_sync_log" ("entity_type", "started_at" DESC);

CREATE TABLE "erp_sync_job" (
  "job_id" bigserial PRIMARY KEY,
  "entity_type" varchar(30) NOT NULL,
  "direction" varchar(10) NOT NULL CHECK ("direction" IN ('pull', 'push')),
  "operation" varchar(80) NOT NULL,
  "idempotency_key" varchar(160) NOT NULL UNIQUE,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" varchar(20) NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending', 'retry', 'processing', 'succeeded', 'dead', 'cancelled')),
  "attempts" int NOT NULL DEFAULT 0,
  "max_attempts" int NOT NULL DEFAULT 5,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" varchar(500),
  "sync_log_id" bigint REFERENCES "erp_sync_log" ("log_id"),
  "locked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CHECK ("attempts" >= 0 AND "max_attempts" >= 1)
);
CREATE INDEX idx_sync_job_due ON "erp_sync_job" ("next_attempt_at")
  WHERE "status" IN ('pending', 'retry');

CREATE TABLE "audit_log" (
  "audit_id" bigserial PRIMARY KEY,
  "actor_type" varchar(20) NOT NULL CHECK ("actor_type" IN ('customer', 'guest', 'admin', 'system')),
  "actor_id" varchar(64),
  "action" varchar(80) NOT NULL,
  "entity_type" varchar(40) NOT NULL,
  "entity_id" varchar(64),
  "before" jsonb,
  "after" jsonb,
  "ip" inet,
  "request_id" varchar(80),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON "audit_log" ("entity_type", "entity_id", "created_at" DESC);
CREATE INDEX idx_audit_actor ON "audit_log" ("actor_type", "actor_id", "created_at" DESC);

-- Idempotency store. `scope` is the route, `key` the caller's header value.
CREATE TABLE "idempotency_key" (
  "scope" varchar(120) NOT NULL,
  "key" varchar(160) NOT NULL,
  "request_hash" char(64) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'in_progress'
    CHECK ("status" IN ('in_progress', 'completed')),
  "status_code" int,
  "response" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL DEFAULT now() + interval '7 days',
  PRIMARY KEY ("scope", "key")
);
CREATE INDEX idx_idempotency_expiry ON "idempotency_key" ("expires_at");

CREATE TABLE "app_counter" (
  "name" varchar(80) PRIMARY KEY,
  "value" bigint NOT NULL DEFAULT 0 CHECK ("value" >= 0)
);

CREATE TABLE "app_setting" (
  "key" varchar(80) PRIMARY KEY,
  "value" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "job" (
  "job_id" bigserial PRIMARY KEY,
  "kind" varchar(60) NOT NULL,
  "dedupe_key" varchar(160) UNIQUE,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" varchar(20) NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending', 'running', 'succeeded', 'failed', 'dead')),
  "attempts" int NOT NULL DEFAULT 0,
  "max_attempts" int NOT NULL DEFAULT 5,
  "run_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" varchar(500),
  "locked_at" timestamptz,
  "locked_by" varchar(80),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_job_due ON "job" ("run_at") WHERE "status" = 'pending';

CREATE TABLE "worker_heartbeat" (
  "worker_name" varchar(60) PRIMARY KEY,
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TRIGGER trg_erp_map_updated BEFORE UPDATE ON "erp_entity_map"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sync_job_updated BEFORE UPDATE ON "erp_sync_job"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_cart_updated BEFORE UPDATE ON "cart"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_cart_item_updated BEFORE UPDATE ON "cart_item"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_reservation_updated BEFORE UPDATE ON "inventory_reservation"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_transaction_updated BEFORE UPDATE ON "payment_transaction"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_refund_updated BEFORE UPDATE ON "refund"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_shipment_updated BEFORE UPDATE ON "shipment"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_order_updated BEFORE UPDATE ON "customer_order"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_variant_updated BEFORE UPDATE ON "product_variant"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_product_updated BEFORE UPDATE ON "product"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_job_updated BEFORE UPDATE ON "job"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
