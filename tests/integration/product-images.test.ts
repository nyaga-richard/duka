import test, { after, before } from "node:test";
import assert from "node:assert/strict";

// ERP integration must be enabled before the application config is imported.
process.env.ERP_ENABLED = "true";
process.env.ERP_BASE_URL = "https://erp.example.test";
process.env.ERP_INTEGRATION_EMAIL = "integration@shop.test";
process.env.ERP_INTEGRATION_PASSWORD = "integration-password-123";
process.env.ERP_ALLOWED_ORIGIN = "https://erp.example.test";

const helpers = await import("../helpers.ts");
const { ErpAdapter, HttpErpTransport } = await import("@ecom/erp-adapter");
const { createFakeErp } = await import("@ecom/erp-adapter/testing/fake-erp.ts");
const sync = await import("../../apps/api/src/services/sync.ts");
const { setErpAdapterForTest } = await import("../../apps/api/src/integrations/erp.ts");
const images = await import("../../apps/api/src/services/product-images.ts");

type TestContext = import("../helpers.ts").TestContext;

let ctx: TestContext;
let fake: ReturnType<typeof createFakeErp>;
let adapter: InstanceType<typeof ErpAdapter>;
const PNG = (() => {
  // 1×1 black PNG, real bytes so the test proves binary passthrough.
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  return new Uint8Array(Buffer.from(base64, "base64"));
})();

before(async () => {
  ctx = await helpers.startTestContext();
  fake = createFakeErp();
  const shirt = fake.createProduct({ sku: "SHIRT-M", name: "Kanzu Shirt", price: "1250.00", stock: "4", active: true });
  fake.attachImage(shirt.id, { bytes: PNG, mime_type: "image/png", filename: "kanzu.png" });

  const transport = new HttpErpTransport({
    baseUrl: "https://erp.example.test",
    email: "integration@shop.test",
    password: "integration-password-123",
    origin: "https://erp.example.test",
    fetchImpl: fake.fetch,
    sleep: async () => undefined,
    maxAttempts: 2,
  });
  adapter = new ErpAdapter(transport, { defaultWarehouseId: "wh-1" });
  setErpAdapterForTest(adapter);
  images.clearImageCache();
});

after(async () => {
  setErpAdapterForTest(null);
  await ctx.cleanup();
});

test("the adapter lists a product's images and downloads their bytes", async () => {
  const [product] = fake.state.products;
  const attachments = await adapter.listProductAttachments(product!.id);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]!.filename, "kanzu.png");
  assert.equal(attachments[0]!.mime_type, "image/png");

  const binary = await adapter.downloadAttachment(attachments[0]!.id);
  assert.equal(binary.contentType, "image/png");
  assert.deepEqual(Array.from(binary.bytes), Array.from(PNG));
});

test("a transport without binary support reports the capability as unsupported", async () => {
  const jsonOnly = new ErpAdapter({
    request: async () => {
      throw new Error("not used");
    },
    health: async () => ({ ok: true, live: true, ready: true }),
  });
  await assert.rejects(() => jsonOnly.downloadAttachment("whatever"), /unsupported|binary/i);
});

test("the catalogue pull records the ERP image as the product's primary image", async () => {
  const summary = await sync.pullCatalog(ctx.db, adapter);
  assert.ok(summary.products >= 1);

  const row = await ctx.db.query<{ image_url: string; alt_text: string; is_primary: boolean }>(
    `SELECT i.image_url, i.alt_text, i.is_primary
       FROM product_image i JOIN product p ON p.product_id = i.product_id
      WHERE p.product_name = 'Kanzu Shirt'`,
  );
  assert.equal(row.rows.length, 1);
  const attachmentId = fake.state.products[0]!.image_attachment_id!;
  assert.equal(row.rows[0]!.image_url, `/api/v1/catalog/images/${attachmentId}`);
  assert.equal(row.rows[0]!.alt_text, "Kanzu Shirt");
  assert.equal(row.rows[0]!.is_primary, true);
});

test("the image route serves the ERP bytes for a published product", async () => {
  const attachmentId = fake.state.products[0]!.image_attachment_id!;
  const response = await fetch(`${ctx.baseUrl}/api/v1/catalog/images/${attachmentId}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("cache-control") ?? "", /max-age=\d+/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(Array.from(bytes), Array.from(PNG));
});

test("the image route refuses unknown ids and unpublished products", async () => {
  const attachmentId = fake.state.products[0]!.image_attachment_id!;
  const unknown = await fetch(`${ctx.baseUrl}/api/v1/catalog/images/00000000-0000-0000-0000-000000000000`);
  assert.equal(unknown.status, 404);

  const malformed = await fetch(`${ctx.baseUrl}/api/v1/catalog/images/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(malformed.status, 404);

  const product = await ctx.db.query<{ product_id: number }>(
    "SELECT product_id FROM product WHERE product_name = 'Kanzu Shirt'",
  );
  await ctx.db.query("UPDATE product SET status = 'draft' WHERE product_id = $1", [product.rows[0]!.product_id]);
  try {
    const hidden = await fetch(`${ctx.baseUrl}/api/v1/catalog/images/${attachmentId}`);
    assert.equal(hidden.status, 404, "a draft product's image must not be fetchable");
  } finally {
    await ctx.db.query("UPDATE product SET status = 'active' WHERE product_id = $1", [product.rows[0]!.product_id]);
  }
});

test("a replaced ERP photo replaces the stored URL", async () => {
  const product = fake.state.products[0]!;
  const replacement = fake.attachImage(product.id, { bytes: PNG, filename: "kanzu-v2.png" });
  await sync.pullCatalog(ctx.db, adapter);
  const row = await ctx.db.query<{ image_url: string }>(
    `SELECT i.image_url FROM product_image i JOIN product p ON p.product_id = i.product_id
      WHERE p.product_name = 'Kanzu Shirt'`,
  );
  assert.equal(row.rows[0]!.image_url, `/api/v1/catalog/images/${replacement.id}`);
});

test("an unreachable ERP degrades to a transparent pixel, uncached", async () => {
  await ctx.db.query("UPDATE product SET status = 'active' WHERE product_name = 'Kanzu Shirt'");
  const attachmentId = fake.state.products[0]!.image_attachment_id!;
  images.clearImageCache();

  const missing = await ctx.db.query<{ image_url: string }>(
    "SELECT image_url FROM product_image ORDER BY image_id LIMIT 1",
  );
  const unreachable = new ErpAdapter(
    {
      request: async () => {
        throw new Error("offline");
      },
      health: async () => ({ ok: false, live: false, ready: false }),
    },
    {},
  );
  setErpAdapterForTest(unreachable);
  try {
    const response = await fetch(`${ctx.baseUrl}/api/v1/catalog/images/${attachmentId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.byteLength < 200, "expected the 1×1 placeholder");
  } finally {
    setErpAdapterForTest(adapter);
    images.clearImageCache();
  }
  assert.ok(missing.rows[0]?.image_url);
});
