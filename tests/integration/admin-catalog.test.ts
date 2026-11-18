import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  addToCart,
  adminClient,
  apiClient,
  guestClient,
  seedCatalogue,
  startTestContext,
  type TestContext,
} from "../helpers.ts";

let ctx: TestContext;
let owner: Awaited<ReturnType<typeof adminClient>>;
let categoryId: number;

before(async () => {
  ctx = await startTestContext();
  owner = await adminClient(ctx.baseUrl, ctx.db);
  const category = await ctx.db.query<{ category_id: number }>(
    "INSERT INTO category(category_name, slug) VALUES('Throws','throws') RETURNING category_id",
  );
  categoryId = category.rows[0]!.category_id;
});

after(async () => {
  await ctx.cleanup();
});

const variant = (overrides: Record<string, unknown> = {}) => ({
  sku: `SKU-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  price: "1500.00",
  qty_in_stock: 4,
  ...overrides,
});

async function createProduct(body: Record<string, unknown> = {}) {
  return owner.post("/api/v1/admin/products", {
    product_name: `Handloom Throw ${Math.random().toString(36).slice(2, 6)}`,
    summary: "Woven in Nakuru",
    status: "draft",
    variants: [
      variant(),
      variant({
        sku: `SKU-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        price: "1900.00",
      }),
    ],
    ...body,
  });
}

test("the desk can create a product with variants", async () => {
  const response = await createProduct({
    category_id: categoryId,
    brand_name: "Duka Home",
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const product = response.data.product;
  assert.equal(product.status, "draft");
  assert.equal(product.is_featured, false);
  assert.equal(product.variants.length, 2);
  assert.equal(product.variants.filter((row: any) => row.is_default).length, 1);
  assert.equal(product.brand_name, "Duka Home");
  assert.equal(product.category_id, categoryId);
  assert.equal(product.category_name, "Throws");
  assert.match(product.slug, /^handloom-throw-/);
  assert.equal(product.variants[0].price, "1500.00");
});

test("an unpublished product is invisible until it is published", async () => {
  const created = (await createProduct({ status: "draft" })).data.product;
  const shopper = apiClient(ctx.baseUrl);
  const before = await shopper.get(`/api/v1/catalog/products/${created.slug}`);
  assert.equal(before.status, 404);

  const published = await owner.patch(
    `/api/v1/admin/products/${created.product_id}`,
    { status: "active" },
  );
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.data.product.status, "active");

  const after = await shopper.get(`/api/v1/catalog/products/${created.slug}`);
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.data.variants.length, 2);
});

test("a product with no active variant cannot be published", async () => {
  const created = (await createProduct({ variants: [] })).data.product;
  assert.equal(created.variants.length, 0);

  const attempt = await owner.patch(
    `/api/v1/admin/products/${created.product_id}`,
    { status: "active" },
  );
  assert.equal(attempt.status, 422, JSON.stringify(attempt.body));
  assert.match(attempt.body.error.message, /active variant/i);

  // Creating one directly as active is refused for the same reason.
  const direct = await createProduct({ status: "active", variants: [] });
  assert.equal(direct.status, 422);
});

test("featuring a product puts it on the landing page and unfeaturing removes it", async () => {
  const featured = (
    await createProduct({ status: "active", is_featured: true })
  ).data.product;
  const plain = (await createProduct({ status: "active" })).data.product;
  const shopper = apiClient(ctx.baseUrl);

  const listed = await shopper.get(
    "/api/v1/catalog/products?featured=true&limit=24",
  );
  assert.equal(listed.status, 200);
  const ids = (listed.data.items as any[]).map((item) => item.product_id);
  assert.ok(
    ids.includes(featured.product_id),
    "featured product should be listed",
  );
  assert.ok(
    !ids.includes(plain.product_id),
    "unfeatured product should not be listed",
  );
  assert.ok(
    (listed.data.items as any[]).every((item) => item.featured === true),
  );

  const off = await owner.patch(
    `/api/v1/admin/products/${featured.product_id}`,
    { is_featured: false },
  );
  assert.equal(off.status, 200);
  const after = await shopper.get(
    "/api/v1/catalog/products?featured=true&limit=24",
  );
  assert.ok(
    !(after.data.items as any[]).some(
      (item) => item.product_id === featured.product_id,
    ),
  );
});

test("variants can be added individually and unpublished one at a time", async () => {
  const created = (
    await createProduct({
      status: "active",
      variants: [variant({ sku: "KEEP-1" })],
    })
  ).data.product;
  const extra = await owner.post(
    `/api/v1/admin/products/${created.product_id}/variants`,
    {
      sku: "HIDE-1",
      price: "2200.00",
      qty_in_stock: 2,
      options: [{ option: "Size", value: "Large" }],
    },
  );
  assert.equal(extra.status, 201, JSON.stringify(extra.body));
  const added = extra.data.variant;
  assert.deepEqual(added.options, [{ option: "Size", value: "Large" }]);
  assert.equal(added.is_active, true);

  const shopper = apiClient(ctx.baseUrl);
  const visible = await shopper.get(`/api/v1/catalog/products/${created.slug}`);
  assert.deepEqual(
    (visible.data.variants as any[]).map((row) => row.sku).sort(),
    ["HIDE-1", "KEEP-1"],
  );

  const hidden = await owner.patch(
    `/api/v1/admin/variants/${added.variant_id}`,
    { is_active: false },
  );
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.equal(hidden.data.variant.is_active, false);

  const after = await shopper.get(`/api/v1/catalog/products/${created.slug}`);
  assert.deepEqual(
    (after.data.variants as any[]).map((row) => row.sku),
    ["KEEP-1"],
  );

  // The hidden variant cannot be bought either.
  const guest = await guestClient(ctx.baseUrl);
  const cart = await addToCart(guest, added.variant_id, 1);
  assert.ok([404, 409, 422].includes(cart.status), JSON.stringify(cart.body));
});

test("variant details stay editable and validated", async () => {
  const created = (
    await createProduct({
      status: "active",
      variants: [variant({ sku: "EDIT-1", price: "1000.00" })],
    })
  ).data.product;
  const variantId = created.variants[0].variant_id;

  const renamed = await owner.patch(`/api/v1/admin/variants/${variantId}`, {
    sku: "EDIT-1-B",
    price: "1250.50",
    qty_in_stock: 9,
    compare_at_price: "1400.00",
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.data.variant.sku, "EDIT-1-B");
  assert.equal(renamed.data.variant.price, "1250.50");
  assert.equal(renamed.data.variant.qty_in_stock, 9);

  const cleared = await owner.patch(`/api/v1/admin/variants/${variantId}`, {
    compare_at_price: null,
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.data.variant.compare_at_price, null);

  const badPrice = await owner.patch(`/api/v1/admin/variants/${variantId}`, {
    price: "-5",
  });
  assert.equal(badPrice.status, 422, JSON.stringify(badPrice.body));

  const badCompare = await owner.patch(`/api/v1/admin/variants/${variantId}`, {
    compare_at_price: "100.00",
  });
  assert.equal(badCompare.status, 422, JSON.stringify(badCompare.body));

  const duplicateSku = await owner.patch(
    `/api/v1/admin/variants/${variantId}`,
    { sku: "EDIT-1-B" },
  );
  assert.equal(
    duplicateSku.status,
    200,
    "renaming to its own sku is not a conflict",
  );

  const clash = await owner.patch(`/api/v1/admin/variants/${variantId}`, {
    sku: "KEEP-1",
  });
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
});

test("an operator can set, replace and clear the product image", async () => {
  const created = (await createProduct({ status: "active" })).data.product;

  const set = await owner.put(
    `/api/v1/admin/products/${created.product_id}/image`,
    {
      image_url: "https://cdn.example.test/throw.jpg",
    },
  );
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.data.product.images.length, 1);
  assert.equal(
    set.data.product.images[0].image_url,
    "https://cdn.example.test/throw.jpg",
  );
  assert.equal(set.data.product.images[0].is_primary, true);

  const replaced = await owner.put(
    `/api/v1/admin/products/${created.product_id}/image`,
    {
      image_url: "https://cdn.example.test/throw-v2.jpg",
    },
  );
  assert.equal(
    replaced.data.product.images.length,
    1,
    "replacing keeps one primary image",
  );
  assert.equal(
    replaced.data.product.images[0].image_url,
    "https://cdn.example.test/throw-v2.jpg",
  );

  const local = await owner.put(
    `/api/v1/admin/products/${created.product_id}/image`,
    {
      image_url: "/images/throw.jpg",
    },
  );
  assert.equal(local.status, 200, "a path this site serves is acceptable");
  assert.equal(local.data.product.images[0].image_url, "/images/throw.jpg");

  for (const bad of [
    "javascript:alert(1)",
    "//evil.example.test/x.jpg",
    "data:image/png;base64,AA",
  ]) {
    const refused = await owner.put(
      `/api/v1/admin/products/${created.product_id}/image`,
      {
        image_url: bad,
      },
    );
    assert.equal(refused.status, 422, `${bad} must be refused`);
  }

  const cleared = await owner.put(
    `/api/v1/admin/products/${created.product_id}/image`,
    { image_url: null },
  );
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.product.images.length, 0);
});

test("duplicate slugs and SKUs are refused with 409", async () => {
  const created = (
    await createProduct({ variants: [variant({ sku: "UNIQUE-1" })] })
  ).data.product;
  const slugClash = await createProduct({ slug: created.slug });
  assert.equal(slugClash.status, 409, JSON.stringify(slugClash.body));

  const skuClash = await owner.post(
    `/api/v1/admin/products/${created.product_id}/variants`,
    {
      sku: "UNIQUE-1",
      price: "10.00",
      qty_in_stock: 1,
    },
  );
  assert.equal(skuClash.status, 409, JSON.stringify(skuClash.body));
});

test("catalog.write is required to change the catalogue", async () => {
  const support = await adminClient(ctx.baseUrl, ctx.db, "support");
  const attempt = await support.post("/api/v1/admin/products", {
    product_name: "Support Product",
  });
  assert.equal(attempt.status, 403, JSON.stringify(attempt.body));

  const readOnly = await support.get("/api/v1/admin/products");
  assert.equal(readOnly.status, 200);
});

test("a guest cart follows the shopper into a new account", async () => {
  const fixture = await seedCatalogue(ctx.db, {
    name: "Guest Gown",
    sku: "GOWN-1",
    price: "3000.00",
    stock: 3,
  });
  const guest = await guestClient(ctx.baseUrl, "adopter@example.test");
  const added = await addToCart(guest, fixture.variant_id, 2);
  assert.equal(added.status, 201, JSON.stringify(added.body));

  const registered = await guest.post("/api/v1/auth/register", {
    email: "adopter@example.test",
    password: "ShopperPassword2026!",
    first_name: "Amina",
    last_name: "Wanjiku",
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  assert.equal(registered.data.cart_adopted, true);
  guest.setCsrfFromBody(registered.data);

  const cart = await guest.get("/api/v1/cart");
  assert.equal(cart.status, 200, JSON.stringify(cart.body));
  assert.equal(cart.data.items.length, 1);
  assert.equal(cart.data.items[0].variant_id, fixture.variant_id);
  assert.equal(cart.data.items[0].quantity, 2);
});

test("signing in keeps the guest cart when the account has none of its own", async () => {
  const fixture = await seedCatalogue(ctx.db, {
    name: "Sign In Scarf",
    sku: "SCARF-1",
    price: "900.00",
    stock: 4,
  });
  const registered = await guestClient(ctx.baseUrl, "signin@example.test");
  // Turn the guest into a customer, then abandon the account's cart by clearing it.
  const account = await registered.post("/api/v1/auth/register", {
    email: "signin@example.test",
    password: "ShopperPassword2026!",
    first_name: "Zawadi",
    last_name: "Otieno",
  });
  assert.equal(account.status, 201, JSON.stringify(account.body));
  registered.setCsrfFromBody(account.data);
  await registered.post("/api/v1/cart/clear");

  // A fresh guest session on another device fills a cart, then signs in.
  const device = await guestClient(ctx.baseUrl);
  const added = await addToCart(device, fixture.variant_id, 1);
  assert.equal(added.status, 201);

  const login = await device.post("/api/v1/auth/login", {
    email: "signin@example.test",
    password: "ShopperPassword2026!",
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.data.cart_adopted, true);
  device.setCsrfFromBody(login.data);

  const cart = await device.get("/api/v1/cart");
  assert.equal(cart.data.items.length, 1);
  assert.equal(cart.data.items[0].variant_id, fixture.variant_id);
});

test("an account that already has a cart keeps its own lines", async () => {
  const mine = await seedCatalogue(ctx.db, {
    name: "Own Caps",
    sku: "CAPS-1",
    price: "700.00",
    stock: 5,
  });
  const other = await seedCatalogue(ctx.db, {
    name: "Guest Belt",
    sku: "BELT-1",
    price: "800.00",
    stock: 5,
  });

  const device = await guestClient(ctx.baseUrl, "twocarts@example.test");
  const guestAdd = await addToCart(device, other.variant_id, 1);
  assert.equal(guestAdd.status, 201);

  // Register (adopts the guest cart), then put a different line in it.
  const registered = await device.post("/api/v1/auth/register", {
    email: "twocarts@example.test",
    password: "ShopperPassword2026!",
    first_name: "Mosi",
    last_name: "Kariuki",
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  device.setCsrfFromBody(registered.data);
  await device.post("/api/v1/cart/clear");
  const ownAdd = await addToCart(device, mine.variant_id, 1);
  assert.equal(ownAdd.status, 201);

  // A second guest session on another device tries to sign in with a cart.
  const second = await guestClient(ctx.baseUrl, "twocarts@example.test");
  const secondAdd = await addToCart(second, other.variant_id, 1);
  assert.equal(secondAdd.status, 201);

  const login = await second.post("/api/v1/auth/login", {
    email: "twocarts@example.test",
    password: "ShopperPassword2026!",
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.data.cart_adopted, false);
  second.setCsrfFromBody(login.data);

  const cart = await second.get("/api/v1/cart");
  assert.deepEqual(
    (cart.data.items as any[]).map((item) => item.variant_id),
    [mine.variant_id],
  );
});
