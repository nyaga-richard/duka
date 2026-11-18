import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { ErpAdapter, ErpError, HttpErpTransport } from "@ecom/erp-adapter";
import { createFakeErp } from "@ecom/erp-adapter/testing/fake-erp.ts";
import {
  startTestContext,
  seedCatalogue,
  customerClient,
  addToCart,
  type TestContext,
} from "../helpers.ts";

// ERP stays disabled here: the worker's own bookkeeping must work without it.
// WORKER_EMBEDDED keeps module import from starting the standalone poll loop.
process.env.WORKER_EMBEDDED = "true";
const { runWorkerTick } = await import("../../apps/api/src/worker.ts");
const sync = await import("../../apps/api/src/services/sync.ts");

const WORKER_NAME = "ecommerce-worker";

let ctx: TestContext;
let fake: ReturnType<typeof createFakeErp>;
let adapter: InstanceType<typeof ErpAdapter>;

before(async () => {
  ctx = await startTestContext();
  fake = createFakeErp();
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

test("a worker tick expires stale holds and records a heartbeat", async () => {
  const product = await seedCatalogue(ctx.db, {
    name: "Kanzu Shirt",
    sku: "WORK-M",
    price: "1250.00",
    stock: 3,
  });
  const customer = await customerClient(ctx.baseUrl, "worker@example.test");
  const added = await addToCart(customer, product.variant_id, 2);
  assert.equal(added.status, 201);

  await ctx.db.query(
    `UPDATE inventory_reservation SET expires_at = now() - interval '5 minutes' WHERE status = 'active'`,
  );
  const tick = await runWorkerTick();
  assert.ok(tick.expired_reservations >= 1);
  assert.equal(
    tick.erp_enabled,
    false,
    "the worker reports the real integration state",
  );

  const heartbeat = await ctx.db.query<{ age_seconds: number }>(
    `SELECT extract(epoch FROM (now() - last_seen_at))::int AS age_seconds
       FROM worker_heartbeat WHERE worker_name = $1`,
    [WORKER_NAME],
  );
  assert.ok(heartbeat.rows[0]);
  assert.ok(heartbeat.rows[0]!.age_seconds <= 5);

  const health = (await (
    await fetch(`${ctx.baseUrl}/health/ready`)
  ).json()) as any;
  assert.equal(health.status, "ready");
  assert.equal(health.checks.worker.stale, false);
  assert.equal(
    health.checks.worker.required,
    false,
    "worker freshness is only a hard requirement in production",
  );
});

test("a job that needs an unsupported ERP capability dies with the contract reference", async () => {
  const job = await sync.enqueueSyncJob(ctx.db, {
    entityType: "refund",
    direction: "push",
    operation: "push_refund",
    localId: "00000000-0000-0000-0000-000000000000",
    payload: { orderId: 1 },
  });

  const processed = await sync.processSyncJobs(ctx.db, adapter, 5);
  const entry = processed.find((item: any) => item.job_id === job.job_id);
  assert.ok(entry, "the due job was claimed by the worker");
  assert.equal(
    entry.status,
    "dead",
    "an unsupported capability is not retried forever",
  );

  const stored = await ctx.db.query<any>(
    "SELECT status, last_error FROM erp_sync_job WHERE job_id = $1",
    [job.job_id],
  );
  assert.equal(stored.rows[0].status, "dead");
  assert.match(stored.rows[0].last_error, /does not expose/i);

  const log = await ctx.db.query<any>(
    "SELECT status, error_code FROM erp_sync_log WHERE operation = 'push_refund' ORDER BY started_at DESC LIMIT 1",
  );
  assert.equal(log.rows[0].status, "failed");
  assert.equal(log.rows[0].error_code, "UNSUPPORTED_CAPABILITY");
});

test("a transient ERP failure schedules a retry with backoff instead of losing the job", async () => {
  const failing = {
    iterateProducts: async function* () {
      throw new ErpError(
        "ERP_UNAVAILABLE",
        "ERP is down",
        503,
        undefined,
        true,
      );
    },
  } as any;

  const job = await sync.enqueueSyncJob(ctx.db, {
    entityType: "catalog",
    direction: "pull",
    operation: "pull_catalog",
    localId: "backoff-test",
  });
  const claimed = await sync.claimDueSyncJob(ctx.db);
  assert.equal(claimed.job_id, job.job_id);
  const outcome = await sync.executeSyncJob(ctx.db, failing, claimed);
  assert.equal(outcome.status, "retry");
  await sync.completeSyncJob(ctx.db, claimed, outcome);

  const stored = await ctx.db.query<any>(
    "SELECT status, next_attempt_at, last_error FROM erp_sync_job WHERE job_id = $1",
    [job.job_id],
  );
  assert.equal(stored.rows[0].status, "retry");
  assert.match(stored.rows[0].last_error, /ERP_UNAVAILABLE|ERP is down/);
  const due = await ctx.db.query<{ seconds: number }>(
    "SELECT extract(epoch FROM (next_attempt_at - now()))::int AS seconds FROM erp_sync_job WHERE job_id = $1",
    [job.job_id],
  );
  assert.ok(due.rows[0]!.seconds > 0, "retry is not immediately due (backoff)");

  const processed = await sync.processSyncJobs(ctx.db, adapter, 5);
  assert.ok(
    !processed.some((entry: any) => entry.job_id === job.job_id),
    "a backed-off job is not claimed again",
  );
});

test("a successful job is drained, logged and marked succeeded", async () => {
  const customer = await customerClient(
    ctx.baseUrl,
    "worker-push@example.test",
  );
  const customerRow = await ctx.db.query<{ customer_id: number }>(
    "SELECT customer_id FROM customer WHERE email = 'worker-push@example.test'",
  );
  assert.ok(customer.cookies.has("ecom_session"));
  const job = await sync.enqueueSyncJob(ctx.db, {
    entityType: "customer",
    direction: "push",
    operation: "push_customer",
    localId: customerRow.rows[0]!.customer_id,
    payload: { customerId: customerRow.rows[0]!.customer_id },
  });

  const processed = await sync.processSyncJobs(ctx.db, adapter, 5);
  assert.ok(
    processed.some(
      (entry: any) =>
        entry.job_id === job.job_id && entry.status === "succeeded",
    ),
  );

  const mapping = await ctx.db.query<any>(
    "SELECT erp_id FROM erp_entity_map WHERE entity_type = 'customer' AND local_id = $1",
    [String(customerRow.rows[0]!.customer_id)],
  );
  assert.ok(mapping.rows[0]?.erp_id);
  assert.equal(fake.state.customers.length, 1);
});

test("the sync overview summarises jobs, mappings and the last runs", async () => {
  const overview = await sync.syncOverview(ctx.db);
  assert.equal(overview.enabled, false, "ERP is disabled in this environment");
  assert.ok(Array.isArray(overview.recent_logs));
  assert.ok(overview.jobs);
});
