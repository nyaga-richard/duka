-- =============================================================================
-- 0004 commerce extensions: carts, reservations, stock movements, payments,
-- webhooks, refunds and shipments.
--
-- Reservation lifecycle (enforced by checks + partial unique indexes):
--   active  -> consumed (order line posted) | released (cart changed) | expired
-- A variant can only hold one *active* reservation per cart/order.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Carts (the ERD's "Cart" status row stays for POS compatibility; the web
-- storefront uses dedicated cart tables so a cart never looks like an order).
-- ---------------------------------------------------------------------------
CREATE TABLE "cart" (
  "cart_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" int REFERENCES "customer" ("customer_id") ON DELETE CASCADE,
  "guest_session_id" uuid REFERENCES "guest_session" ("guest_session_id") ON DELETE CASCADE,
  "status" varchar(20) NOT NULL DEFAULT 'active'
    CHECK ("status" IN ('active', 'converted', 'abandoned', 'merged')),
  "currency" char(3) NOT NULL DEFAULT 'KES',
  "reservation_expires_at" timestamptz,
  "converted_order_id" int,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_cart_owner CHECK (num_nonnulls("customer_id", "guest_session_id") = 1)
);
CREATE UNIQUE INDEX uq_active_cart_customer ON "cart" ("customer_id") WHERE "status" = 'active';
CREATE UNIQUE INDEX uq_active_cart_guest ON "cart" ("guest_session_id") WHERE "status" = 'active';
CREATE INDEX idx_cart_expiry ON "cart" ("reservation_expires_at") WHERE "status" = 'active';

CREATE TABLE "cart_item" (
  "cart_item_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "cart_id" uuid NOT NULL REFERENCES "cart" ("cart_id") ON DELETE CASCADE,
  "variant_id" int NOT NULL REFERENCES "product_variant" ("variant_id"),
  "quantity" int NOT NULL CHECK ("quantity" > 0 AND "quantity" <= 100),
  "unit_price_snapshot" decimal(10,2) NOT NULL CHECK ("unit_price_snapshot" >= 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("cart_id", "variant_id")
);

-- ---------------------------------------------------------------------------
-- Reservations and movements
-- ---------------------------------------------------------------------------
CREATE TABLE "inventory_reservation" (
  "reservation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "cart_id" uuid REFERENCES "cart" ("cart_id") ON DELETE CASCADE,
  "order_id" int,
  "variant_id" int NOT NULL REFERENCES "product_variant" ("variant_id"),
  "quantity" int NOT NULL CHECK ("quantity" > 0),
  "status" varchar(20) NOT NULL DEFAULT 'active'
    CHECK ("status" IN ('active', 'consumed', 'released', 'expired')),
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "closed_at" timestamptz,
  "close_reason" varchar(60),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_reservation_owner CHECK (num_nonnulls("cart_id", "order_id") >= 1)
);
CREATE UNIQUE INDEX uq_active_reservation_cart_variant
  ON "inventory_reservation" ("cart_id", "variant_id") WHERE "status" = 'active';
CREATE INDEX idx_reservation_expiry
  ON "inventory_reservation" ("expires_at") WHERE "status" = 'active';
CREATE INDEX idx_reservation_order ON "inventory_reservation" ("order_id");
CREATE INDEX idx_reservation_variant_active
  ON "inventory_reservation" ("variant_id") WHERE "status" = 'active';

CREATE TABLE "inventory_movement" (
  "movement_id" bigserial PRIMARY KEY,
  "variant_id" int NOT NULL REFERENCES "product_variant" ("variant_id"),
  "quantity_delta" int NOT NULL CHECK ("quantity_delta" <> 0),
  "quantity_after" int NOT NULL CHECK ("quantity_after" >= 0),
  "reason" varchar(40) NOT NULL
    CHECK ("reason" IN ('erp_sync', 'order_placed', 'order_cancelled', 'refund_restock', 'manual_adjustment', 'opening')),
  "source_type" varchar(30) NOT NULL,
  "source_id" varchar(80),
  "reservation_id" uuid REFERENCES "inventory_reservation" ("reservation_id"),
  "actor" varchar(80) NOT NULL DEFAULT 'system',
  "note" varchar(255),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_movement_variant ON "inventory_movement" ("variant_id", "created_at" DESC);
CREATE UNIQUE INDEX uq_movement_source
  ON "inventory_movement" ("reason", "source_type", "source_id", "variant_id")
  WHERE "source_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Order extensions
-- ---------------------------------------------------------------------------
ALTER TABLE "customer_order"
  ADD COLUMN "order_number" varchar(32),
  ADD COLUMN "guest_session_id" uuid REFERENCES "guest_session" ("guest_session_id"),
  ADD COLUMN "email" varchar(255),
  ADD COLUMN "currency" char(3) NOT NULL DEFAULT 'KES',
  ADD COLUMN "channel" varchar(20) NOT NULL DEFAULT 'web'
    CHECK ("channel" IN ('web', 'admin', 'pos')),
  ADD COLUMN "payment_status" varchar(30) NOT NULL DEFAULT 'unpaid'
    CHECK ("payment_status" IN ('unpaid', 'pending', 'paid', 'partially_refunded', 'refunded', 'failed')),
  ADD COLUMN "placed_at" timestamptz,
  ADD COLUMN "cancelled_at" timestamptz,
  ADD COLUMN "cancellation_reason" varchar(255),
  ADD COLUMN "reservation_expires_at" timestamptz,
  ADD COLUMN "notes" text,
  ADD COLUMN "tax_total" decimal(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "erp_state" varchar(20) NOT NULL DEFAULT 'pending'
    CHECK ("erp_state" IN ('pending', 'syncing', 'synced', 'failed', 'disabled'));

ALTER TABLE "customer_order" ALTER COLUMN "customer_id" DROP NOT NULL;
ALTER TABLE "customer_order" ALTER COLUMN "order_status_id" SET DEFAULT 1;
ALTER TABLE "customer_order"
  ADD CONSTRAINT ck_order_owner
    CHECK (num_nonnulls("customer_id", "guest_session_id") = 1),
  ADD CONSTRAINT ck_order_totals
    CHECK (
      COALESCE("subtotal", 0) >= 0
      AND COALESCE("discount_total", 0) >= 0
      AND COALESCE("shipping_cost", 0) >= 0
      AND COALESCE("order_total", 0) >= 0
    ),
  ADD CONSTRAINT ck_order_math
    CHECK (
      "order_total" IS NULL
      OR "subtotal" IS NULL
      OR "order_total" = "subtotal" - COALESCE("discount_total", 0) + COALESCE("shipping_cost", 0)
    );
CREATE UNIQUE INDEX uq_order_number ON "customer_order" ("order_number") WHERE "order_number" IS NOT NULL;
CREATE INDEX idx_order_customer ON "customer_order" ("customer_id", "created_at" DESC);
CREATE INDEX idx_order_guest ON "customer_order" ("guest_session_id", "created_at" DESC);
CREATE INDEX idx_order_status ON "customer_order" ("order_status_id", "created_at" DESC);
CREATE INDEX idx_order_email ON "customer_order" (lower("email"));

ALTER TABLE "order_line"
  ADD COLUMN "product_id" int REFERENCES "product" ("product_id"),
  ADD COLUMN "line_total" decimal(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "tax_amount" decimal(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "option_snapshot" jsonb;
ALTER TABLE "order_line"
  ALTER COLUMN "unit_price" SET NOT NULL,
  ALTER COLUMN "discount_amount" SET DEFAULT 0,
  ALTER COLUMN "discount_amount" SET NOT NULL,
  ADD CONSTRAINT ck_line_quantity CHECK ("quantity" > 0),
  ADD CONSTRAINT ck_line_prices CHECK (
    "unit_price" >= 0 AND "discount_amount" >= 0 AND "line_total" >= 0 AND "tax_amount" >= 0
  );
CREATE INDEX idx_line_order ON "order_line" ("order_id");
CREATE INDEX idx_line_variant ON "order_line" ("variant_id");

ALTER TABLE "payment"
  ADD COLUMN "currency" char(3) NOT NULL DEFAULT 'KES',
  ADD COLUMN "payment_transaction_id" uuid;
ALTER TABLE "payment" ADD CONSTRAINT ck_payment_amount CHECK ("amount" > 0);
CREATE UNIQUE INDEX uq_payment_transaction ON "payment" ("payment_transaction_id")
  WHERE "payment_transaction_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Payment attempts, provider webhooks, refunds
-- ---------------------------------------------------------------------------
CREATE TABLE "payment_transaction" (
  "transaction_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" int NOT NULL REFERENCES "customer_order" ("order_id"),
  "provider" varchar(30) NOT NULL CHECK ("provider" IN ('manual', 'mpesa', 'card', 'fake')),
  "provider_reference" varchar(120),
  "amount" decimal(10,2) NOT NULL CHECK ("amount" > 0),
  "currency" char(3) NOT NULL DEFAULT 'KES',
  "status" varchar(30) NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending', 'requires_action', 'succeeded', 'failed', 'cancelled', 'refunded', 'partially_refunded')),
  "idempotency_key" varchar(120) NOT NULL,
  "request_payload" jsonb,
  "response_payload" jsonb,
  "failure_reason" varchar(255),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  UNIQUE ("order_id", "idempotency_key")
);
CREATE UNIQUE INDEX uq_transaction_provider_reference
  ON "payment_transaction" ("provider", "provider_reference")
  WHERE "provider_reference" IS NOT NULL;
CREATE INDEX idx_transaction_order ON "payment_transaction" ("order_id", "created_at" DESC);

ALTER TABLE "payment" ADD FOREIGN KEY ("payment_transaction_id")
  REFERENCES "payment_transaction" ("transaction_id");

CREATE TABLE "payment_webhook" (
  "webhook_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider" varchar(30) NOT NULL,
  "event_id" varchar(160) NOT NULL,
  "event_type" varchar(80) NOT NULL,
  "signature_valid" boolean NOT NULL,
  "payload" jsonb NOT NULL,
  "headers" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" varchar(20) NOT NULL DEFAULT 'received'
    CHECK ("status" IN ('received', 'processed', 'ignored', 'failed')),
  "attempts" int NOT NULL DEFAULT 0,
  "error" varchar(500),
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  UNIQUE ("provider", "event_id")
);
CREATE INDEX idx_webhook_status ON "payment_webhook" ("status", "received_at");

CREATE TABLE "refund" (
  "refund_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" int NOT NULL REFERENCES "customer_order" ("order_id"),
  "payment_transaction_id" uuid REFERENCES "payment_transaction" ("transaction_id"),
  "amount" decimal(10,2) NOT NULL CHECK ("amount" > 0),
  "currency" char(3) NOT NULL DEFAULT 'KES',
  "reason" varchar(255) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'requested'
    CHECK ("status" IN ('requested', 'approved', 'processing', 'succeeded', 'failed', 'cancelled')),
  "provider_reference" varchar(120),
  "idempotency_key" varchar(120) NOT NULL,
  "requested_by" uuid REFERENCES "admin_user" ("admin_user_id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  UNIQUE ("idempotency_key")
);
CREATE INDEX idx_refund_order ON "refund" ("order_id", "created_at" DESC);
CREATE INDEX idx_refund_transaction ON "refund" ("payment_transaction_id");

-- ---------------------------------------------------------------------------
-- Shipments
-- ---------------------------------------------------------------------------
CREATE TABLE "shipment" (
  "shipment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" int NOT NULL REFERENCES "customer_order" ("order_id"),
  "shipping_method_id" int REFERENCES "shipping_method" ("shipping_method_id"),
  "carrier" varchar(80) NOT NULL,
  "tracking_number" varchar(120),
  "tracking_url" varchar(500),
  "status" varchar(20) NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending', 'dispatched', 'in_transit', 'delivered', 'failed', 'returned')),
  "erp_reference" varchar(120),
  "shipped_at" timestamptz,
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_shipment_tracking ON "shipment" ("carrier", "tracking_number")
  WHERE "tracking_number" IS NOT NULL;
CREATE INDEX idx_shipment_order ON "shipment" ("order_id", "created_at" DESC);

CREATE TABLE "shipment_item" (
  "shipment_id" uuid NOT NULL REFERENCES "shipment" ("shipment_id") ON DELETE CASCADE,
  "order_line_id" int NOT NULL REFERENCES "order_line" ("order_line_id"),
  "quantity" int NOT NULL CHECK ("quantity" > 0),
  PRIMARY KEY ("shipment_id", "order_line_id")
);

ALTER TABLE "cart" ADD FOREIGN KEY ("converted_order_id")
  REFERENCES "customer_order" ("order_id");

-- Reviews can only reference a purchased line (enforced in the API) and carry
-- moderation state so the storefront never shows unapproved content.
ALTER TABLE "review"
  ADD COLUMN "customer_id" int REFERENCES "customer" ("customer_id"),
  ADD COLUMN "title" varchar(160),
  ADD COLUMN "status" varchar(20) NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending', 'published', 'rejected')),
  ADD COLUMN "published_at" timestamptz;
CREATE INDEX idx_review_line ON "review" ("order_line_id");
