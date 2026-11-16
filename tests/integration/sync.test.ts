import test, { after, before } from "node:test";
import assert from "node:assert/strict";

// ERP integration must be enabled before the application config is imported.
process.env.ERP_ENABLED = "true";
process.env.ERP_BASE_URL = "https://erp.example.test";
process.env.ERP_INTEGRATION_EMAIL = "integration@shop.test";
process.env.ERP_INTEGRATION_PASSWORD = "integration-password-123";
process.env.ERP_ALLOWED_ORIGIN = "https://erp.example.test";
process.env.ERP_DEFAULT_BRANCH_ID = "branch-1";
process.env.ERP_DEFAULT_WAREHOUSE_ID = "wh-1";

const helpers = await import("../helpers.ts");
const { ErpAdapter, HttpErpTransport } = await import("@ecom/erp-adapter");
const { createFakeErp } = await import("@ecom/erp-adapter/testing/fake-erp.ts");
const sync = await import("../../apps/api/src/services/sync.ts");

type TestContext = import("../helpers.ts").TestContext;

let ctx: TestContext;
let fake: ReturnType<typeof createFakeErp>;
let adapter: InstanceType<typeof ErpAdapter>;
let shirtVariantId: number;

before(async () => {
  ctx = await helpers.startTestContext();
  fake = createFakeErp();
  fake.createProduct({
    sku: "SHIRT-M",
    name: "Kanzu Shirt",
    price: "1250.00",
    brand: "Duka",
    category: "Shirts",
    stock: "8",
    reserved: "0",
    active: true,
  });
  const mug = fake.createProduct({ sku: "MUG-01", name: "Ceramic Mug", price: "450.50", stock: "4", reserved: "0", active: true });
  fake.createProduct({
    sku: "MUG-RED",
    name: "Ceramic Mug - Red",
    price: "470.00",
    parent_id: mug.id,
    stock: "4",
    reserved: "0",
    active: true,
  });

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
});

after(async () => {
  await ctx.cleanup();
});

test("sync jobs are deduplicated by their deterministic key", async () => {
  const first = await sync.enqueueSyncJob(ctx.db, {
    entityType: "catalog",
    direction: "pull",
    operation: "pull_catalog",
    localId: "all",
  });
  const second = await sync.enqueueSyncJob(ctx.db, {
    entityType: "catalog",
    direction: "pull",
    operation: "pull_catalog",
    localId: "all",
  });
  assert.equal(first.job_id, second.job_id);
  const count = await ctx.db.query<{ count: number }>("SELECT count(*)::int AS count FROM erp_sync_job");
  assert.equal(count.rows[0]!.count, 1);
});

test("pullCatalog mirrors the ERP catalogue once and maps products and variants", async () => {
  const result = await sync.pullCatalog(ctx.db, adapter);
  assert.equal(result.products, 2, "two ERP parents become two local products");
  assert.equal(result.variants, 3, "each parent gets a default variant and the ERP child is a variant");

  const products = await ctx.db.query<any>("SELECT product_id, product_name, status, sync_state FROM product ORDER BY product_id");
  assert.equal(products.rows.length, 2);
  assert.ok(products.rows.every((row) => row.sync_state === "synced"));

  const variants = await ctx.db.query<any>(
    `SELECT v.variant_id, v.sku, v.price::text AS price, v.qty_in_stock, v.product_id
       FROM product_variant v`,
  );
  assert.equal(variants.rows.length, 3);
  const child = variants.rows.find((row) => row.sku === "MUG-RED");
  assert.ok(child, "the self-referencing ERP child is stored as a variant");
  assert.equal(child.price, "470.00");
  shirtVariantId = variants.rows.find((row) => row.sku === "SHIRT-M").variant_id;

  const mappings = await ctx.db.query<any>("SELECT entity_type, local_id, erp_id FROM erp_entity_map ORDER BY entity_type");
  assert.ok(mappings.rows.some((row) => row.entity_type === "product"));
  assert.ok(mappings.rows.some((row) => row.entity_type === "variant"));

  const again = await sync.pullCatalog(ctx.db, adapter);
  assert.equal(again.products, 2);
  const after = await ctx.db.query<{ count: number }>("SELECT count(*)::int AS count FROM product");
  assert.equal(after.rows[0]!.count, 2, "a second pull updates instead of duplicating");

  const logs = await ctx.db.query<any>("SELECT status FROM erp_sync_log WHERE operation = 'pull_catalog'");
  assert.ok(logs.rows.length >= 1);
  assert.ok(logs.rows.every((row) => row.status === "succeeded"));
});

test("pullInventory updates local stock from ERP balances", async () => {
  const balance = fake.state.inventory[0];
  if (balance) balance.quantity = "11";
  else {
    for (const product of fake.state.products) {
      fake.state.inventory.push({
        product_id: product.id,
        warehouse_id: "wh-1",
        quantity: "11",
        reserved: "0",
        available: "11",
        value: "0",
        version: 2,
      });
    }
  }
  const result = await sync.pullInventory(ctx.db, adapter);
  assert.ok(result.updated >= 1);
  const variant = await ctx.db.query<{ qty_in_stock: number }>(
    "SELECT qty_in_stock FROM product_variant WHERE variant_id = $1",
    [shirtVariantId],
  );
  assert.equal(variant.rows[0]!.qty_in_stock, 11);
});

test("a web order is pushed as an ERP sales order document once", async () => {
  const customer = await helpers.customerClient(ctx.baseUrl, "sync-buyer@example.test");
  const added = await helpers.addToCart(customer, shirtVariantId, 1);
  assert.equal(added.status, 201);
  const placed = await helpers.checkout(customer, { key: "sync-order-1" });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const orderId = placed.data.order.order_id;

  const queued = await ctx.db.query<any>(
    "SELECT job_id, operation, status FROM erp_sync_job WHERE operation = 'push_order_document'",
  );
  assert.equal(queued.rows.length, 1, "checkout queues the ERP projection when integration is on");

  const pushed = await sync.pushOrderDocument(ctx.db, adapter, orderId);
  assert.ok("erp_document_id" in pushed);
  assert.equal(fake.state.documents.length, 1);
  assert.equal(fake.state.documents[0]!.total, "1250.00", "the ERP values its own document from ERP prices");

  const mapping = await ctx.db.query<any>(
    "SELECT erp_id FROM erp_entity_map WHERE entity_type = 'order' AND local_id = $1",
    [String(orderId)],
  );
  assert.equal(mapping.rows[0].erp_id, fake.state.documents[0]!.id);

  const order = await ctx.db.query<{ erp_state: string }>("SELECT erp_state FROM customer_order WHERE order_id = $1", [orderId]);
  assert.equal(order.rows[0]!.erp_state, "synced");

  const again = await sync.pushOrderDocument(ctx.db, adapter, orderId);
  assert.equal((again as any).skipped, true);
  assert.equal(fake.state.documents.length, 1, "never creates a second document for the same order");
});

test("customers are searched before being created, then mapped to the ERP", async () => {
  const customer = await ctx.db.query<{ customer_id: number }>(
    "SELECT customer_id FROM customer WHERE email = 'sync-buyer@example.test'",
  );
  const customerId = customer.rows[0]!.customer_id;
  const created = await sync.pushCustomer(ctx.db, adapter, customerId);
  assert.ok(created.erp_customer_id);
  assert.equal(created.matched_existing, false);
  const mapping = await ctx.db.query<any>(
    "SELECT erp_id FROM erp_entity_map WHERE entity_type = 'customer' AND local_id = $1",
    [String(customerId)],
  );
  assert.equal(mapping.rows[0].erp_id, created.erp_customer_id);
  assert.ok(fake.state.customers.some((entry) => entry.id === created.erp_customer_id));

  const repeat = await sync.pushCustomer(ctx.db, adapter, customerId);
  assert.equal((repeat as any).skipped, true, "mapped customers are not created twice");
  assert.equal(fake.state.customers.length, 1);
});

test("processSyncJobs drains due jobs and records attempts", async () => {
  const outcome = await sync.processSyncJobs(ctx.db, adapter, 10);
  assert.ok(Array.isArray(outcome));
  const jobs = await ctx.db.query<any>("SELECT operation, status FROM erp_sync_job ORDER BY created_at");
  assert.ok(jobs.rows.some((job) => job.operation === "push_order_document" && job.status === "succeeded"));
  const logs = await ctx.db.query<{ count: number }>("SELECT count(*)::int AS count FROM erp_sync_log");
  assert.ok(logs.rows[0]!.count >= 2);
});
