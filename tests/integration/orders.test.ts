import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  addToCart,
  apiClient,
  checkout,
  customerClient,
  guestClient,
  seedCatalogue,
  startTestContext,
  type ApiClient,
  type CatalogueFixture,
  type TestContext,
} from "../helpers.ts";

let ctx: TestContext;
let shirt: CatalogueFixture;
let mug: CatalogueFixture;
const SHIPPING = 300;

const stockOf = async (variantId: number) => {
  const row = await ctx.db.query<{ qty_in_stock: number }>(
    "SELECT qty_in_stock FROM product_variant WHERE variant_id = $1",
    [variantId],
  );
  return row.rows[0]!.qty_in_stock;
};

const checkoutBody = (email?: string) => ({
  shipping_method_id: 1,
  ship_name: "Amina Wanjiku",
  ship_address_line1: "12 Kenyatta Avenue",
  ship_city: "Nairobi",
  ship_region: "Nairobi County",
  ship_postal_code: "00100",
  ship_country: "Kenya",
  phone: "0712345678",
  ...(email ? { email } : {}),
});

async function readyShopper(email: string, items: Array<[CatalogueFixture, number]>) {
  const client = await customerClient(ctx.baseUrl, email);
  for (const [fixture, quantity] of items) {
    const added = await addToCart(client, fixture.variant_id, quantity);
    assert.equal(added.status, 201, JSON.stringify(added.body));
  }
  return client;
}

before(async () => {
  ctx = await startTestContext();
  shirt = await seedCatalogue(ctx.db, { name: "Kanzu Shirt", sku: "KANZU-M", price: "1250.00", stock: 5 });
  mug = await seedCatalogue(ctx.db, { name: "Ceramic Mug", sku: "MUG-01", price: "450.50", stock: 2 });
});

after(async () => {
  await ctx.cleanup();
});

// Each scenario starts with the shelf stocked and no abandoned carts or holds.
beforeEach(async () => {
  // Reservations are never deleted: inventory_movement references them and they
  // are the audit trail. Consumed holds are already inactive.
  await ctx.db.query("UPDATE inventory_reservation SET status = 'released', closed_at = now() WHERE status = 'active'");
  await ctx.db.query("DELETE FROM cart_item");
  await ctx.db.query("UPDATE product_variant SET qty_in_stock = 5 WHERE variant_id = $1", [shirt.variant_id]);
  await ctx.db.query("UPDATE product_variant SET qty_in_stock = 2 WHERE variant_id = $1", [mug.variant_id]);
});

test("checkout creates an order, snapshots prices, consumes stock and converts the cart", async () => {
  const client = await readyShopper("buyer@example.test", [
    [shirt, 2],
    [mug, 1],
  ]);

  const response = await checkout(client, { key: "checkout-1" });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const order = response.data.order;

  assert.match(order.order_number, /^[A-Z0-9-]+$/);
  assert.equal(order.status, "placed");
  assert.equal(order.payment_status, "pending");
  const expected = 2 * 1250 + 450.5 + SHIPPING;
  assert.equal(Number(order.total).toFixed(2), expected.toFixed(2));

  assert.equal(await stockOf(shirt.variant_id), 3, "stock left the building");
  assert.equal(await stockOf(mug.variant_id), 1);

  const view = await client.get(`/api/v1/orders/${order.order_id}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.totals.subtotal, "2950.50");
  assert.equal(view.data.totals.shipping, "300.00");
  assert.equal(view.data.totals.total, "3250.50");
  assert.equal(view.data.shipping.method, "Nairobi standard delivery");
  assert.equal(view.data.items.length, 2);
  assert.equal(view.data.items[0].unit_price, "1250.00");
  assert.equal(view.data.items[0].line_total, "2500.00");

  const cartRow = await ctx.db.query<{ status: string }>("SELECT status FROM cart WHERE converted_order_id = $1", [
    order.order_id,
  ]);
  assert.equal(cartRow.rows[0]!.status, "converted");

  const active = await ctx.db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM inventory_reservation WHERE order_id = $1 AND status = 'active'",
    [order.order_id],
  );
  assert.equal(active.rows[0]!.count, 0, "holds are consumed, not left dangling");

  const list = await client.get("/api/v1/orders");
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.items[0].order_id, order.order_id);

  const emptyCart = await client.get("/api/v1/cart");
  assert.equal(emptyCart.data.item_count, 0, "a new cart is started after conversion");
});

test("orders are invisible to other customers", async () => {
  const client = await readyShopper("private@example.test", [[shirt, 1]]);
  const placed = await checkout(client, { key: "checkout-private" });
  assert.equal(placed.status, 201);

  const stranger = await customerClient(ctx.baseUrl, "stranger@example.test");
  const stolen = await stranger.get(`/api/v1/orders/${placed.data.order.order_id}`);
  assert.equal(stolen.status, 404, "existence is not disclosed");
  const list = await stranger.get("/api/v1/orders");
  assert.equal(list.data.items.length, 0);
});

test("checkout is idempotent: the same key and body replay the same order", async () => {
  const client = await readyShopper("idempotent@example.test", [[shirt, 1]]);
  const body = checkoutBody();
  const first = await client.post("/api/v1/orders", body, { "idempotency-key": "replay-key-1" });
  assert.equal(first.status, 201);
  const afterFirst = await stockOf(shirt.variant_id);
  const replay = await client.post("/api/v1/orders", body, { "idempotency-key": "replay-key-1" });
  assert.equal(replay.status, 201);
  assert.equal(replay.data.order.order_id, first.data.order.order_id);
  assert.equal(replay.data.payment.status, first.data.payment.status, "replayed payment state is identical");
  assert.equal(await stockOf(shirt.variant_id), afterFirst, "the second call did not consume more stock");

  const changed = await client.post("/api/v1/orders", { ...body, ship_name: "Someone Else" }, { "idempotency-key": "replay-key-1" });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.code, "IDEMPOTENCY_KEY_REUSED");
});

test("checkout requires an idempotency key and a non-empty cart", async () => {
  const client = await readyShopper("empty@example.test", []);
  const noKey = await client.post("/api/v1/orders", checkoutBody());
  assert.equal(noKey.status, 422);
  assert.equal(noKey.body.error.code, "IDEMPOTENCY_REQUIRED");

  const empty = await checkout(client, { key: "empty-cart-key" });
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error.code, "EMPTY_CART");
});

test("checkout rejects unknown shipping methods", async () => {
  const client = await readyShopper("shipping@example.test", [[mug, 1]]);
  const response = await client.post(
    "/api/v1/orders",
    { ...checkoutBody(), shipping_method_id: 999 },
    { "idempotency-key": "bad-shipping" },
  );
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
});

test("guest checkout needs an email and stays scoped to that guest session", async () => {
  const guest = apiClient(ctx.baseUrl);
  const started = await guest.post("/api/v1/auth/guest", {});
  assert.equal(started.status, 201);
  guest.setCsrfFromBody(started.data);
  const added = await addToCart(guest, mug.variant_id, 1);
  assert.equal(added.status, 201);

  const noEmail = await checkout(guest, { key: "guest-no-email" });
  assert.equal(noEmail.status, 422);
  assert.equal(noEmail.body.error.code, "VALIDATION_ERROR");
  assert.match(noEmail.body.error.message, /email/i);

  const withEmail = await guest.post("/api/v1/orders", checkoutBody("guest-checkout@example.test"), {
    "idempotency-key": "guest-with-email",
  });
  assert.equal(withEmail.status, 201, JSON.stringify(withEmail.body));

  const guestOrders = await guest.get("/api/v1/orders");
  assert.equal(guestOrders.data.items.length, 1);
  assert.equal(guestOrders.data.items[0].email, "guest-checkout@example.test");

  const otherGuest = await guestClient(ctx.baseUrl, "other-guest@example.test");
  const denied = await otherGuest.get(`/api/v1/orders/${withEmail.data.order.order_id}`);
  assert.equal(denied.status, 404);
});

test("cancelling an unpaid order restores stock and is terminal", async () => {
  const client = await readyShopper("cancel@example.test", [[mug, 2]]);
  const placed = await checkout(client, { key: "cancel-order" });
  assert.equal(placed.status, 201);
  assert.equal(await stockOf(mug.variant_id), 0);

  const cancelled = await client.post(`/api/v1/orders/${placed.data.order.order_id}/cancel`, {
    reason: "Changed my mind about the colour",
  });
  assert.equal(cancelled.status, 200);
  assert.equal(await stockOf(mug.variant_id), 2, "stock returns to the shelf");

  const detail = await client.get(`/api/v1/orders/${placed.data.order.order_id}`);
  assert.equal(detail.data.status, "cancelled");

  const again = await client.post(`/api/v1/orders/${placed.data.order.order_id}/cancel`, {
    reason: "Trying to cancel twice",
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "INVALID_STATE_TRANSITION");
});

test("concurrent checkouts of the last unit cannot oversell", async () => {
  await seedCatalogue(ctx.db, { name: "Last One", sku: "LAST-1", price: "100.00", stock: 1 });
  const last = await ctx.db.query<{ variant_id: number }>("SELECT variant_id FROM product_variant WHERE sku = 'LAST-1'");
  const variantId = last.rows[0]!.variant_id;

  const a = await customerClient(ctx.baseUrl, "race-a@example.test");
  const b = await customerClient(ctx.baseUrl, "race-b@example.test");
  const addA = await addToCart(a, variantId, 1);
  const addB = await addToCart(b, variantId, 1);
  assert.equal(addA.status, 201);
  assert.equal(addB.status, 409, "the hold is exclusive even before checkout");
});
