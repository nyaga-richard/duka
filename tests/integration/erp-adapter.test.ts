import test from "node:test";
import assert from "node:assert/strict";
import { ErpAdapter, ErpError, HttpErpTransport } from "@ecom/erp-adapter";
import { createFakeErp } from "@ecom/erp-adapter/testing/fake-erp.ts";

const ORIGIN = "https://erp.example.test";

function harness(
  options: {
    permissions?: string[];
    allowSelfApproval?: boolean;
    openShifts?: Set<string>;
  } = {},
) {
  const fake = createFakeErp({
    permissions: options.permissions,
    allowSelfApproval: options.allowSelfApproval ?? false,
    openShifts: options.openShifts ?? new Set<string>(),
  });
  const transport = new HttpErpTransport({
    baseUrl: "https://erp.example.test",
    email: "integration@shop.test",
    password: "integration-password-123",
    origin: ORIGIN,
    fetchImpl: fake.fetch,
    sleep: async () => undefined,
    maxAttempts: 3,
  });
  const adapter = new ErpAdapter(transport, { defaultWarehouseId: "wh-1" });
  return { fake, transport, adapter };
}

test("the adapter logs in once, sends Origin on mutations and reports identity", async () => {
  const { fake, adapter } = harness();
  const probe = await adapter.probe();
  assert.equal(probe.health.ok, true);
  assert.equal(probe.identity?.email, "integration@shop.test");
  assert.ok(probe.identity?.permissions.includes("catalog.read"));
  assert.equal(fake.state.loginAttempts, 1, "single-flight login");

  await adapter.probe();
  assert.equal(
    fake.state.loginAttempts,
    1,
    "the session is reused across calls",
  );
});

test("a single 401 forces exactly one re-login", async () => {
  const { fake, adapter } = harness();
  await adapter.probe();
  assert.equal(fake.state.loginAttempts, 1);
  fake.expireSessions();
  const probe = await adapter.probe();
  assert.equal(probe.identity?.email, "integration@shop.test");
  assert.equal(fake.state.loginAttempts, 2);
});

test("catalogue pages map cleanly and pagination terminates", async () => {
  const { fake, adapter } = harness();
  fake.createProduct({ sku: "SHIRT-M", name: "Kanzu Shirt", price: "1250.00" });
  const parent = fake.createProduct({
    sku: "MUG",
    name: "Ceramic Mug",
    price: "450.50",
  });
  fake.createProduct({
    sku: "MUG-RED",
    name: "Ceramic Mug – Red",
    price: "470.00",
    parent_id: parent.id,
  });

  const first = await adapter.listProducts({ limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.total, 3);
  const all: string[] = [];
  for await (const product of adapter.iterateProducts(2)) all.push(product.sku);
  assert.deepEqual(all.sort(), ["MUG", "MUG-RED", "SHIRT-M"]);
  assert.equal(
    fake.state.requests.filter((request) => request.path === "/api/v1/products")
      .length,
    3,
    "one page read plus two pages of the walk",
  );
});

test("inventory balances are read-only and paginated", async () => {
  const { fake, adapter } = harness();
  const product = fake.createProduct({
    sku: "SHIRT-M",
    name: "Kanzu Shirt",
    price: "1250.00",
    stock: "6",
    reserved: "1",
  });
  fake.state.inventory.push({
    product_id: product.id,
    warehouse_id: "wh-1",
    quantity: "6",
    reserved: "1",
    available: "5",
    value: "7500.00",
    version: 1,
  });
  const page = await adapter.listInventory({ limit: 50 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.available, "5");
  assert.equal(page.items[0]!.reserved, "1");
});

test("customer create is idempotent and conflicts are typed", async () => {
  const { adapter } = harness();
  const created = await adapter.createCustomer({
    name: "Amina Wanjiku",
    code: "WEB-1",
    email: "amina@example.test",
  });
  assert.ok(created.id);
  const replay = await adapter.createCustomer({
    name: "Amina Wanjiku",
    code: "WEB-1",
    email: "amina@example.test",
  });
  assert.equal(replay.id, created.id);

  await assert.rejects(
    () =>
      adapter.createCustomer({
        name: "Someone Else",
        code: "WEB-1",
        email: "other@example.test",
      }),
    (error: any) => error instanceof ErpError && error.code === "ERP_CONFLICT",
  );
});

test("sales order approval refuses self-approval and lacks stock reservation (reported gap)", async () => {
  const { adapter } = harness();
  const document = await adapter.createSalesOrderDocument({
    customerId: "cust-1",
    branchId: "branch-1",
    lines: [{ productId: "prod-1", quantity: "1", unitPrice: "1250.00" }],
  });
  assert.ok(document.id);
  await assert.rejects(
    () =>
      adapter.transitionDocument(
        document.id,
        "approved",
        "self approval attempt",
      ),
    (error: any) => error instanceof ErpError && error.code === "ERP_FORBIDDEN",
  );
});

test("POST /sales without an open shift surfaces the ERP precondition", async () => {
  const { adapter } = harness();
  await assert.rejects(
    () =>
      adapter.postSale(
        {
          customerId: "cust-1",
          registerId: "reg-1",
          lines: [{ productId: "prod-1", quantity: "1", unitPrice: "1250.00" }],
          payments: [],
        },
        "ecommerce:test-sale-1",
      ),
    (error: any) => error instanceof ErpError && error.code === "ERP_NOT_FOUND",
  );
});

test("transient ERP failures are retried with backoff, then surface as unavailable", async () => {
  const { fake, adapter } = harness();
  let attempts = 0;
  const transport = new HttpErpTransport({
    baseUrl: "https://erp.example.test",
    email: "integration@shop.test",
    password: "integration-password-123",
    origin: ORIGIN,
    fetchImpl: async (input: any, init?: RequestInit) => {
      if (String(input).includes("/api/v1/products")) {
        attempts += 1;
        return new Response(
          JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return fake.fetch(input, init);
    },
    sleep: async () => undefined,
    maxAttempts: 3,
  });
  const retrying = new ErpAdapter(transport);
  await assert.rejects(
    () => retrying.listProducts({}),
    (error: any) =>
      error instanceof ErpError && error.code === "ERP_UNAVAILABLE",
  );
  assert.equal(attempts, 3, "three attempts before giving up");
});

test("429 is retryable and rate limiting is typed", async () => {
  const { fake, adapter } = harness();
  let calls = 0;
  const transport = new HttpErpTransport({
    baseUrl: "https://erp.example.test",
    email: "integration@shop.test",
    password: "integration-password-123",
    origin: ORIGIN,
    fetchImpl: async (input: any, init?: RequestInit) => {
      if (String(input).includes("/api/v1/inventory/balances")) {
        calls += 1;
        return new Response(
          JSON.stringify({
            error: { code: "RATE_LIMITED", message: "slow down" },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return fake.fetch(input, init);
    },
    sleep: async () => undefined,
    maxAttempts: 2,
  });
  const limited = new ErpAdapter(transport);
  await assert.rejects(
    () => limited.listInventory({}),
    (error: any) =>
      error instanceof ErpError && error.code === "ERP_RATE_LIMITED",
  );
  assert.equal(calls, 2);
});
