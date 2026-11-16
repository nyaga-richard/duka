import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  addToCart,
  adminClient,
  checkout,
  customerClient,
  seedCatalogue,
  startTestContext,
  type ApiClient,
  type CatalogueFixture,
  type TestContext,
} from "../helpers.ts";

let ctx: TestContext;
let variant: CatalogueFixture;

async function orderFor(email: string, quantity = 1) {
  const client = await customerClient(ctx.baseUrl, email);
  await addToCart(client, variant.variant_id, quantity);
  const placed = await checkout(client, { key: `manual-${email}` });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  return { client, orderId: placed.data.order.order_id as number, total: String(placed.data.order.total) };
}

async function paidOrderFor(email: string, admin: ApiClient) {
  const { client, orderId, total } = await orderFor(email);
  const recorded = await admin.post(`/api/v1/admin/orders/${orderId}/payments`, {
    amount: total,
    reference: `BANK-${orderId}`,
  });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
  return { client, orderId, total, recorded };
}

before(async () => {
  ctx = await startTestContext();
  variant = await seedCatalogue(ctx.db, { name: "Kanzu Shirt", sku: "PAY-M", price: "1000.00", stock: 20 });
});

after(async () => {
  await ctx.cleanup();
});

test("manual mode is the default and never claims capture is enabled", async () => {
  const health = (await (await fetch(`${ctx.baseUrl}/health/ready`)).json()) as any;
  assert.equal(health.checks.payments_mode, "manual");
  assert.equal(health.checks.payment_capture_enabled, false);

  const { client } = await orderFor("manual-default@example.test");
  const orders = await client.get("/api/v1/orders");
  const detail = await client.get(`/api/v1/orders/${orders.data.items[0].order_id}`);
  assert.equal(detail.data.payment_status, "pending");
  assert.equal(detail.data.status, "placed");
});

test("an administrator records a manual payment and the order becomes paid", async () => {
  const admin = await adminClient(ctx.baseUrl, ctx.db);
  const { client, orderId, total } = await orderFor("manual-pay@example.test");
  const recorded = await admin.post(`/api/v1/admin/orders/${orderId}/payments`, {
    amount: total,
    reference: "BANK-REF-001",
    note: "Cash received at the counter",
  });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
  assert.equal(recorded.data.paymentStatus, "paid");
  assert.equal(recorded.data.order.status, "paid");
  assert.equal(recorded.data.order.payment_status, "paid");

  const payments = await ctx.db.query<{ amount: string; payment_status: string; provider: string }>(
    `SELECT p.amount::text AS amount, p.payment_status, t.provider
       FROM payment p JOIN payment_transaction t ON t.transaction_id = p.payment_transaction_id
      WHERE p.order_id = $1`,
    [orderId],
  );
  assert.equal(payments.rows.length, 1);
  assert.equal(payments.rows[0]!.payment_status, "succeeded");

  const audit = await ctx.db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM audit_log WHERE action = 'payment.recorded_manually'",
  );
  assert.ok(audit.rows[0]!.count >= 1, "manual capture is audited");

  const cancel = await client.post(`/api/v1/orders/${orderId}/cancel`, { reason: "Cannot cancel a paid order" });
  assert.equal(cancel.status, 409, "paid orders need a refund, not a cancellation");
});

test("manual payments cannot exceed the outstanding balance", async () => {
  const admin = await adminClient(ctx.baseUrl, ctx.db);
  const { orderId, total } = await orderFor("manual-overpay@example.test");
  const tooMuch = await admin.post(`/api/v1/admin/orders/${orderId}/payments`, {
    amount: (Number(total) + 1).toFixed(2),
    reference: "BANK-OVER",
  });
  assert.equal(tooMuch.status, 422);
  assert.match(tooMuch.body.error.message, /exceeds/i);

  const wrongPerson = await customerClient(ctx.baseUrl, "manual-nothing@example.test");
  const denied = await wrongPerson.post(`/api/v1/admin/orders/${orderId}/payments`, {
    amount: "10.00",
    reference: "NOPE",
  });
  assert.equal(denied.status, 401);
});

test("refunds need an idempotency key, respect the refundable balance and replay safely", async () => {
  const admin = await adminClient(ctx.baseUrl, ctx.db);
  const { orderId, total } = await paidOrderFor("manual-refund@example.test", admin);

  const noKey = await admin.post(`/api/v1/admin/orders/${orderId}/refunds`, {
    amount: "10.00",
    reason: "Customer returned the item",
  });
  assert.equal(noKey.status, 422);
  assert.equal(noKey.body.error.code, "IDEMPOTENCY_REQUIRED");

  const partial = await admin.post(
    `/api/v1/admin/orders/${orderId}/refunds`,
    { amount: "500.00", reason: "Partial refund for a small defect" },
    { "idempotency-key": "refund-1" },
  );
  assert.equal(partial.status, 201, JSON.stringify(partial.body));
  const replay = await admin.post(
    `/api/v1/admin/orders/${orderId}/refunds`,
    { amount: "500.00", reason: "Partial refund for a small defect" },
    { "idempotency-key": "refund-1" },
  );
  assert.equal(replay.status, 201);
  assert.equal(replay.data.refund_id, partial.data.refund_id);
  assert.equal(replay.data.replayed, true);

  const order = await admin.get(`/api/v1/admin/orders/${orderId}`);
  assert.equal(order.data.payment_status, "partially_refunded");

  const tooMuch = await admin.post(
    `/api/v1/admin/orders/${orderId}/refunds`,
    { amount: total, reason: "Trying to refund more than remains" },
    { "idempotency-key": "refund-2" },
  );
  assert.equal(tooMuch.status, 422);
  assert.match(tooMuch.body.error.message, /refundable/i);

  const rest = (Number(total) - 500).toFixed(2);
  const complete = await admin.post(
    `/api/v1/admin/orders/${orderId}/refunds`,
    { amount: rest, reason: "Remaining balance refunded", restock: true },
    { "idempotency-key": "refund-3" },
  );
  assert.equal(complete.status, 201);
  const finalOrder = await admin.get(`/api/v1/admin/orders/${orderId}`);
  assert.equal(finalOrder.data.payment_status, "refunded");
  assert.equal(finalOrder.data.status, "refunded");
});

test("refunds require the refunds.write permission", async () => {
  const owner = await adminClient(ctx.baseUrl, ctx.db);
  const { orderId } = await paidOrderFor("manual-rbac@example.test", owner);

  const support = await adminClient(ctx.baseUrl, ctx.db, "support", "support-refund@shop.test");
  const denied = await support.post(
    `/api/v1/admin/orders/${orderId}/refunds`,
    { amount: "1.00", reason: "Support should not be able to refund" },
    { "idempotency-key": "refund-rbac" },
  );
  assert.equal(denied.status, 403);
});

test("a refund with no captured payment is refused", async () => {
  const admin = await adminClient(ctx.baseUrl, ctx.db);
  const { orderId } = await orderFor("manual-unpaid-refund@example.test");
  const response = await admin.post(
    `/api/v1/admin/orders/${orderId}/refunds`,
    { amount: "10.00", reason: "Nothing was captured on this order" },
    { "idempotency-key": "refund-unpaid" },
  );
  assert.equal(response.status, 409);
});
