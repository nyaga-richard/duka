import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  addToCart,
  apiClient,
  checkout,
  guestClient,
  seedCatalogue,
  startTestContext,
  type CatalogueFixture,
  type TestContext,
} from "../helpers.ts";

let ctx: TestContext;
let shirt: CatalogueFixture;

before(async () => {
  ctx = await startTestContext();
  shirt = await seedCatalogue(ctx.db, {
    name: "Kanzu Shirt",
    sku: "KANZU-M",
    price: "1250.00",
    stock: 8,
  });
});

after(async () => {
  await ctx.cleanup();
});

async function placeGuestOrder(email: string) {
  const guest = await guestClient(ctx.baseUrl, email);
  const added = await addToCart(guest, shirt.variant_id, 2);
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const placed = await checkout(guest, { email, shippingMethodId: 2 });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  return placed.data.order as {
    order_id: number;
    order_number: string;
    total: string;
  };
}

const lookup = (
  client: ReturnType<typeof apiClient>,
  orderNumber: string,
  email: string,
) => client.post("/api/v1/orders/lookup", { order_number: orderNumber, email });

test("delivery options are public and priced by the store", async () => {
  const anonymous = apiClient(ctx.baseUrl);
  const response = await anonymous.get("/api/v1/catalog/shipping-methods");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const items = response.data.items as Array<{
    shipping_method_id: number;
    method_name: string;
    price: string;
    code: string;
  }>;
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((item) => item.shipping_method_id),
    [1, 2, 3],
  );
  assert.equal(items[0]!.price, "300.00");
  assert.equal(items[0]!.code, "nairobi-standard");
  assert.equal(items[2]!.price, "0.00");

  // A deactivated option disappears from the shop but stays on old orders.
  await ctx.db.query(
    "UPDATE shipping_method SET is_active = false WHERE shipping_method_id = 3",
  );
  try {
    const after = await anonymous.get("/api/v1/catalog/shipping-methods");
    assert.deepEqual(
      (after.data.items as Array<{ shipping_method_id: number }>).map(
        (item) => item.shipping_method_id,
      ),
      [1, 2],
    );
  } finally {
    await ctx.db.query(
      "UPDATE shipping_method SET is_active = true WHERE shipping_method_id = 3",
    );
  }
});

test("an order is found by number and email from a device with no session", async () => {
  const order = await placeGuestOrder("lookup-one@example.test");

  // A brand new client: no guest cookie, no CSRF token, nothing carried over.
  const stranger = apiClient(ctx.baseUrl);
  const response = await lookup(
    stranger,
    order.order_number,
    "lookup-one@example.test",
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const found = response.data.order;
  assert.equal(found.order_id, order.order_id);
  assert.equal(found.order_number, order.order_number);
  assert.equal(found.totals.total, order.total);
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].quantity, 2);
  assert.equal(found.shipping.method, "Countrywide courier");
  assert.equal(found.shipping.city, "Nairobi");
});

test("the order number is matched case-insensitively and tolerates padding", async () => {
  const order = await placeGuestOrder("lookup-two@example.test");
  const stranger = apiClient(ctx.baseUrl);
  const response = await lookup(
    stranger,
    `  ${order.order_number.toLowerCase()} `,
    " Lookup-Two@Example.Test ",
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.data.order.order_id, order.order_id);
});

test("a wrong email, a wrong number and an unknown order all look the same", async () => {
  const order = await placeGuestOrder("lookup-three@example.test");
  const stranger = apiClient(ctx.baseUrl);

  const wrongEmail = await lookup(
    stranger,
    order.order_number,
    "someone-else@example.test",
  );
  const wrongNumber = await lookup(
    stranger,
    "DUK-1999-999999",
    "lookup-three@example.test",
  );
  const unknown = await lookup(
    stranger,
    "DUK-1999-000000",
    "nobody@example.test",
  );

  for (const response of [wrongEmail, wrongNumber, unknown]) {
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.body.error.code, "NOT_FOUND");
    assert.equal(
      response.body.error.message,
      "No order matches that number and email address",
    );
  }
});

test("lookup rejects malformed input before touching the database", async () => {
  const stranger = apiClient(ctx.baseUrl);
  const short = await stranger.post("/api/v1/orders/lookup", {
    order_number: "1",
    email: "guest@example.test",
  });
  assert.equal(short.status, 422, JSON.stringify(short.body));
  assert.equal(short.body.error.code, "VALIDATION_ERROR");

  const noEmail = await stranger.post("/api/v1/orders/lookup", {
    order_number: "DUK-2026-000001",
  });
  assert.equal(noEmail.status, 422, JSON.stringify(noEmail.body));

  const extra = await stranger.post("/api/v1/orders/lookup", {
    order_number: "DUK-2026-000001",
    email: "guest@example.test",
    order_id: 1,
  });
  assert.equal(extra.status, 422, JSON.stringify(extra.body));
});

test("lookup is rate limited per address", async () => {
  const stranger = apiClient(ctx.baseUrl);
  let limited: Awaited<ReturnType<typeof lookup>> | null = null;
  for (let attempt = 0; attempt < 12 && !limited; attempt += 1) {
    const response = await lookup(
      stranger,
      "DUK-1999-111111",
      "nobody@example.test",
    );
    if (response.status === 429) limited = response;
  }
  assert.ok(
    limited,
    "expected the lookup bucket to close after repeated misses",
  );
  assert.equal(limited.body.error.code, "RATE_LIMITED");
});
