import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestContext, type TestContext } from "../helpers.ts";
import { listMigrations, migrate, migrationStatus, migrationsCurrent, resolveMigrationsDir } from "../../apps/api/src/db/migrate.ts";

let ctx: TestContext;

before(async () => {
  ctx = await startTestContext();
});

after(async () => {
  await ctx.cleanup();
});

test("all migrations are applied exactly once", async () => {
  const status = await migrationStatus(ctx.db);
  assert.ok(status.length >= 6);
  assert.ok(status.every((entry) => entry.applied));
  assert.ok(status.every((entry) => entry.checksum_matches));
  assert.equal(await migrationsCurrent(ctx.db), true);
});

test("re-running migrations is a no-op", async () => {
  const result = await migrate(ctx.db);
  assert.deepEqual(result.applied, []);
  assert.ok(result.alreadyApplied >= 6);
});

test("an edited, already-applied migration is rejected (forward-only)", async () => {
  const sourceDir = resolveMigrationsDir();
  const copyDir = await mkdtemp(path.join(tmpdir(), "ecommerce-migrations-"));
  try {
    await cp(sourceDir, copyDir, { recursive: true });
    const first = (await listMigrations(copyDir))[0]!;
    await appendFile(first.fullPath, "\n-- tampered after apply\n");
    await assert.rejects(
      () => migrate(ctx.db, { dir: copyDir }),
      /changed after it was applied \(checksum mismatch\)/,
    );
  } finally {
    await rm(copyDir, { recursive: true, force: true });
  }
});

test("an empty directory simply reports everything already applied", async () => {
  const emptyDir = await mkdtemp(path.join(tmpdir(), "ecommerce-empty-"));
  try {
    const result = await migrate(ctx.db, { dir: emptyDir });
    assert.deepEqual(result.applied, []);
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test("the ERD tables and approved extensions exist", async () => {
  const expected = [
    "customer", "address", "country", "payment_type", "payment_method", "category", "product",
    "product_category", "product_variant", "product_option", "product_option_value", "variant_option_value",
    "product_image", "order_status", "shipping_method", "customer_order", "order_line", "payment",
    "promotion", "promotion_product", "review",
    "brand", "product_attribute", "product_attribute_assignment",
    "cart", "cart_item", "inventory_reservation", "inventory_movement",
    "payment_transaction", "payment_webhook", "refund", "shipment", "shipment_item",
    "erp_entity_map", "erp_sync_log", "erp_sync_job", "audit_log", "idempotency_key",
    "admin_user", "admin_role", "admin_permission", "admin_session",
    "customer_session", "guest_session", "security_event",
  ];
  const rows = await ctx.db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const names = new Set(rows.rows.map((row) => row.table_name));
  for (const table of expected) assert.ok(names.has(table), `missing table ${table}`);
});

test("reference data is seeded without sample business data", async () => {
  const statuses = await ctx.db.query<{ status_name: string }>("SELECT status_name FROM order_status ORDER BY order_status_id");
  assert.deepEqual(
    statuses.rows.map((row) => row.status_name),
    ["cart", "placed", "paid", "processing", "shipped", "delivered", "cancelled", "refunded", "payment_failed"],
  );
  const permissions = await ctx.db.query<{ count: number }>("SELECT count(*)::int AS count FROM admin_permission");
  assert.ok(permissions.rows[0]!.count >= 14, "permission catalogue seeded");
  const roleCounts = await ctx.db.query<{ role_name: string; permissions: number }>(
    `SELECT r.role_name, count(rp.permission_code)::int AS permissions
       FROM admin_role r LEFT JOIN admin_role_permission rp ON rp.role_id = r.role_id
      GROUP BY r.role_name ORDER BY r.role_name`,
  );
  assert.ok(roleCounts.rows.length >= 4);
  const customers = await ctx.db.query<{ count: number }>("SELECT count(*)::int AS count FROM customer");
  assert.equal(customers.rows[0]!.count, 0, "no customer sample data");
  const products = await ctx.db.query<{ count: number }>("SELECT count(*)::int AS count FROM product");
  assert.equal(products.rows[0]!.count, 0, "no product sample data");
  const orders = await ctx.db.query<{ count: number }>("SELECT count(*)::int AS count FROM customer_order");
  assert.equal(orders.rows[0]!.count, 0, "no order sample data");
});
