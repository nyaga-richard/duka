import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// The fake provider only exists outside production; it is selected before the
// application config module is imported below.
process.env.PAYMENTS_MODE = "fake";
process.env.PAYMENT_CAPTURE_ENABLED = "true";

const { startTestContext, seedCatalogue, customerClient, addToCart, checkout } = await import("../helpers.ts");
type TestContext = import("../helpers.ts").TestContext;
type CatalogueFixture = import("../helpers.ts").CatalogueFixture;

const SECRET = "test-secret";
const sign = (raw: string) => createHmac("sha256", SECRET).update(raw).digest("hex");

async function postWebhook(baseUrl: string, provider: string, payload: Record<string, unknown>, options: { signature?: string | null } = {}) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = options.signature === undefined ? sign(raw) : options.signature;
  if (signature) headers["x-webhook-signature"] = signature;
  const response = await fetch(`${baseUrl}/api/v1/webhooks/payments/${provider}`, { method: "POST", headers, body: raw });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { status: response.status, body, data: body?.data };
}

let ctx: TestContext;
let variant: CatalogueFixture;

async function placedOrder(email: string) {
  const client = await customerClient(ctx.baseUrl, email);
  await addToCart(client, variant.variant_id, 1);
  const placed = await checkout(client, { key: `webhook-${email}` });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  assert.equal(placed.data.payment.status, "requires_action");
  return { client, orderId: placed.data.order.order_id as number, total: String(placed.data.order.total) };
}

before(async () => {
  ctx = await startTestContext();
  variant = await seedCatalogue(ctx.db, { name: "Webhook Shirt", sku: "WH-M", price: "1000.00", stock: 10 });
});

after(async () => {
  await ctx.cleanup();
});

test("the fake provider is active and orders wait for a signed webhook", async () => {
  const health = (await (await fetch(`${ctx.baseUrl}/health/ready`)).json()) as any;
  assert.equal(health.checks.payments_mode, "fake");
  const { client } = await placedOrder("wh-waiting@example.test");
  const orders = await client.get("/api/v1/orders");
  assert.equal(orders.data.items[0].payment_status, "pending");
  assert.equal(orders.data.items[0].status, "placed");
});

test("an unsigned webhook is recorded and rejected, and changes nothing", async () => {
  const { orderId, client } = await placedOrder("wh-unsigned@example.test");
  const reference = await ctx.db.query<{ provider_reference: string }>(
    "SELECT provider_reference FROM payment_transaction WHERE order_id = $1",
    [orderId],
  );
  const response = await postWebhook(ctx.baseUrl, "fake", {
    event_id: "evt-unsigned-1",
    reference: reference.rows[0]!.provider_reference,
    status: "succeeded",
    amount: "1300.00",
  }, { signature: null });
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "FORBIDDEN");

  const webhook = await ctx.db.query<any>(
    "SELECT signature_valid, status, error FROM payment_webhook WHERE event_id = 'evt-unsigned-1'",
  );
  assert.equal(webhook.rows[0].signature_valid, false);
  assert.equal(webhook.rows[0].status, "ignored");

  const order = await client.get(`/api/v1/orders/${orderId}`);
  assert.equal(order.data.payment_status, "pending");
});

test("a signed webhook for an unknown reference is processed without side effects", async () => {
  const response = await postWebhook(ctx.baseUrl, "fake", {
    event_id: "evt-unknown-ref",
    reference: "fake-DOES-NOT-EXIST",
    status: "succeeded",
    amount: "1300.00",
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.processed, false);
  assert.equal(response.data.reason, "No matching payment transaction");
});

test("a signed success webhook marks the order paid exactly once", async () => {
  const { orderId, client } = await placedOrder("wh-paid@example.test");
  const reference = await ctx.db.query<{ provider_reference: string }>(
    "SELECT provider_reference FROM payment_transaction WHERE order_id = $1",
    [orderId],
  );
  const payload = {
    event_id: "evt-paid-1",
    event_type: "payment.succeeded",
    reference: reference.rows[0]!.provider_reference,
    status: "succeeded",
    amount: "1300.00",
  };
  const first = await postWebhook(ctx.baseUrl, "fake", payload);
  assert.equal(first.status, 200);
  assert.equal(first.data.processed, true);
  assert.equal(first.data.duplicate, false);

  const order = await client.get(`/api/v1/orders/${orderId}`);
  assert.equal(order.data.payment_status, "paid");
  assert.equal(order.data.status, "paid");
  const payments = await ctx.db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM payment WHERE order_id = $1",
    [orderId],
  );
  assert.equal(payments.rows[0]!.count, 1);

  const duplicate = await postWebhook(ctx.baseUrl, "fake", payload);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.duplicate, true);
  const stillOne = await ctx.db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM payment WHERE order_id = $1",
    [orderId],
  );
  assert.equal(stillOne.rows[0]!.count, 1, "duplicate events never double-credit");

  const cancel = await client.post(`/api/v1/orders/${orderId}/cancel`, { reason: "Paid orders need a refund" });
  assert.equal(cancel.status, 409);
  assert.match(cancel.body.error.message, /cannot be cancelled/i);
});

test("a signed failure webhook moves a pending order to payment_failed", async () => {
  const { orderId, client } = await placedOrder("wh-failed@example.test");
  const reference = await ctx.db.query<{ provider_reference: string }>(
    "SELECT provider_reference FROM payment_transaction WHERE order_id = $1",
    [orderId],
  );
  const response = await postWebhook(ctx.baseUrl, "fake", {
    event_id: "evt-failed-1",
    reference: reference.rows[0]!.provider_reference,
    status: "failed",
    amount: "1300.00",
  });
  assert.equal(response.status, 200);
  const order = await client.get(`/api/v1/orders/${orderId}`);
  assert.equal(order.data.payment_status, "failed");
  assert.equal(order.data.status, "payment_failed");

  const cancellation = await client.post(`/api/v1/orders/${orderId}/cancel`, {
    reason: "Payment failed so I cancelled",
  });
  assert.equal(cancellation.status, 200, "a failed payment is still cancellable");
});

test("a provider that is not the active one cannot post webhooks", async () => {
  const response = await postWebhook(ctx.baseUrl, "mpesa", { event_id: "evt-mpesa-1", status: "succeeded" });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "NOT_FOUND");
});
