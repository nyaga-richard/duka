import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  addToCart,
  apiClient,
  customerClient,
  guestClient,
  seedCatalogue,
  startTestContext,
  type CatalogueFixture,
  type TestContext,
} from "../helpers.ts";
import { expireStaleReservations } from "../../apps/api/src/services/reservations.ts";

let ctx: TestContext;
let shirt: CatalogueFixture;
let mug: CatalogueFixture;

const reservedOf = async (variantId: number) => {
  const row = await ctx.db.query<{ total: number }>(
    `SELECT coalesce(sum(quantity),0)::int AS total FROM inventory_reservation
      WHERE variant_id = $1 AND status = 'active'`,
    [variantId],
  );
  return row.rows[0]!.total;
};

before(async () => {
  ctx = await startTestContext();
  shirt = await seedCatalogue(ctx.db, { name: "Kanzu Shirt", sku: "KANZU-M", price: "1250.00", stock: 5 });
  mug = await seedCatalogue(ctx.db, { name: "Ceramic Mug", sku: "MUG-01", price: "450.50", stock: 2 });
  await seedCatalogue(ctx.db, { name: "Hidden Draft", sku: "DRAFT-1", price: "999.00", stock: 5, status: "draft" });
});

after(async () => {
  await ctx.cleanup();
});

// Each scenario starts from an empty storefront: carts, holds and stock reset.
beforeEach(async () => {
  await ctx.db.query("DELETE FROM inventory_reservation");
  await ctx.db.query("DELETE FROM cart_item");
  await ctx.db.query("DELETE FROM cart");
  await ctx.db.query("UPDATE product_variant SET qty_in_stock = 5 WHERE variant_id = $1", [shirt.variant_id]);
  await ctx.db.query("UPDATE product_variant SET qty_in_stock = 2 WHERE variant_id = $1", [mug.variant_id]);
});

test("the public catalogue exposes published products with live availability only", async () => {
  const client = apiClient(ctx.baseUrl);
  const list = await client.get("/api/v1/catalog/products?limit=10");
  assert.equal(list.status, 200);
  const names = list.data.items.map((item: any) => item.name ?? item.product_name);
  assert.ok(names.includes("Kanzu Shirt"));
  assert.ok(names.includes("Ceramic Mug"));
  assert.ok(!names.includes("Hidden Draft"), "draft products stay private");

  const withPrices = list.data.items.find((item: any) => (item.name ?? item.product_name) === "Kanzu Shirt");
  assert.equal(withPrices.variants[0].price, "1250.00");
  assert.equal(withPrices.variants[0].available, 5);

  const search = await client.get("/api/v1/catalog/products?q=kanzu");
  assert.equal(search.data.items.length, 1);
  const missing = await client.get("/api/v1/catalog/products?q=zzzznothing");
  assert.equal(missing.data.items.length, 0);
});

test("product detail works by slug and numeric id and hides drafts", async () => {
  const client = apiClient(ctx.baseUrl);
  const bySlug = await client.get(`/api/v1/catalog/products/${shirt.slug}`);
  assert.equal(bySlug.status, 200);
  assert.equal(bySlug.data.product_id, shirt.product_id);
  assert.equal(bySlug.data.variants[0].sku, "KANZU-M");

  const byId = await client.get(`/api/v1/catalog/products/${shirt.product_id}`);
  assert.equal(byId.status, 200);
  assert.equal(byId.data.slug, shirt.slug);

  const unknown = await client.get("/api/v1/catalog/products/nope-nope");
  assert.equal(unknown.status, 404);
});

test("categories and brands are listed with counts", async () => {
  const client = apiClient(ctx.baseUrl);
  const categories = await client.get("/api/v1/catalog/categories");
  assert.equal(categories.status, 200);
  const shirts = categories.data.items.find((c: any) => c.slug === "shirts");
  assert.ok(shirts);
  assert.ok(shirts.product_count >= 2);

  const brands = await client.get("/api/v1/catalog/brands");
  assert.ok(brands.data.items.length >= 2);
});

test("an anonymous visitor gets a guest cart and a CSRF token, then can keep shopping", async () => {
  const client = apiClient(ctx.baseUrl);
  const first = await client.post("/api/v1/cart/items", { variant_id: shirt.variant_id, quantity: 2 });
  assert.equal(first.status, 201);
  assert.ok(client.cookies.has("ecom_guest"), "guest session cookie issued");
  assert.ok(first.data.csrf_token, "CSRF token returned so the SPA can continue");
  client.setCsrfFromBody(first.data);

  assert.equal(first.data.cart.item_count, 2);
  assert.equal(first.data.cart.subtotal, "2500.00");
  assert.equal(await reservedOf(shirt.variant_id), 2);

  const second = await client.post("/api/v1/cart/items", { variant_id: mug.variant_id, quantity: 1 });
  assert.equal(second.status, 201, "second write succeeds with the returned CSRF token");
  assert.equal(second.data.cart.item_count, 3);
  assert.equal(second.data.cart.subtotal, "2950.50");
});

test("adding more than available stock is refused without creating a reservation", async () => {
  const guest = await guestClient(ctx.baseUrl, "oversell@example.test");
  const response = await addToCart(guest, mug.variant_id, 3);
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "INSUFFICIENT_STOCK");
  assert.equal(await reservedOf(mug.variant_id), 0);
});

test("quantities update, zero removes, and removal releases the hold", async () => {
  const guest = await guestClient(ctx.baseUrl, "quantities@example.test");
  await addToCart(guest, shirt.variant_id, 1);

  const update = await guest.request("PATCH", `/api/v1/cart/items/${shirt.variant_id}`, { body: { quantity: 3 } });
  assert.equal(update.status, 200);
  assert.equal(update.data.items[0].quantity, 3);
  assert.equal(await reservedOf(shirt.variant_id), 3);

  const zero = await guest.request("PATCH", `/api/v1/cart/items/${shirt.variant_id}`, { body: { quantity: 0 } });
  assert.equal(zero.status, 200);
  assert.equal(zero.data.items.length, 0);
  assert.equal(await reservedOf(shirt.variant_id), 0);

  await addToCart(guest, shirt.variant_id, 2);
  const removed = await guest.del(`/api/v1/cart/items/${shirt.variant_id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.items.length, 0);
  assert.equal(await reservedOf(shirt.variant_id), 0);

  const clear = await guest.post("/api/v1/cart/clear");
  assert.equal(clear.status, 200);
});

test("carts are private to their owner", async () => {
  const amina = await customerClient(ctx.baseUrl, "cart-amina@example.test");
  const brian = await customerClient(ctx.baseUrl, "cart-brian@example.test");
  await addToCart(amina, mug.variant_id, 1);

  const aminaCart = await amina.get("/api/v1/cart");
  assert.equal(aminaCart.data.item_count, 1);
  const brianCart = await brian.get("/api/v1/cart");
  assert.equal(brianCart.data.item_count, 0);

  const brianDelete = await brian.del(`/api/v1/cart/items/${mug.variant_id}`);
  assert.equal(brianDelete.status, 404, "cannot touch another cart's line");
  assert.equal(await reservedOf(mug.variant_id), 1);
});

test("expired holds are swept and stock becomes available again", async () => {
  const guest = await guestClient(ctx.baseUrl, "expiry@example.test");
  await addToCart(guest, mug.variant_id, 2);
  assert.equal(await reservedOf(mug.variant_id), 2);

  await ctx.db.query(
    `UPDATE inventory_reservation SET expires_at = now() - interval '1 minute'
      WHERE variant_id = $1 AND status = 'active'`,
    [mug.variant_id],
  );
  const swept = await expireStaleReservations(ctx.db);
  assert.ok(swept.expired >= 1);
  assert.ok(swept.carts.length >= 1);

  const rest = await ctx.db.query<{ status: string }>(
    "SELECT status FROM inventory_reservation WHERE variant_id = $1",
    [mug.variant_id],
  );
  assert.ok(rest.rows.every((row) => row.status !== "active"));
  assert.equal(await reservedOf(mug.variant_id), 0);

  const view = await guest.get("/api/v1/cart");
  assert.equal(view.data.items[0].available, 2);
});
