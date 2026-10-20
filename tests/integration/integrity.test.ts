import { fixture } from "./helper.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction, one } from "../../apps/api/src/db.ts";
import { createProduct } from "../../apps/api/src/services/catalog.ts";
import { postStockDocument } from "../../apps/api/src/services/inventory.ts";
import { verifyIntegrity } from "../../apps/api/src/services/integrity.ts";
import { postJournal } from "@duka/accounting";
import { productSchema } from "@duka/shared";
after(() => pool.end());
test("independent integrity checks detect missing stock cache and forged AR control while incomplete warehouse scopes fail explicitly", async () => {
  const f = await fixture();
  const p = await transaction(f.actor, async (ctx) => {
    const unit = await one(
        ctx,
        "SELECT id FROM units WHERE company_id=$1 AND symbol='pc'",
        [f.companyId],
      ),
      tax = await one(
        ctx,
        "SELECT id FROM tax_rules WHERE company_id=$1 AND code='VAT16'",
        [f.companyId],
      );
    const p = await createProduct(
      ctx,
      productSchema.parse({
        name: "Integrity regression item",
        sku: "INTEGRITY",
        unit_id: unit.id,
        tax_rule_id: tax.id,
        price: "116",
      }),
    );
    await postStockDocument(ctx, {
      type: "opening",
      warehouse_id: f.warehouseId,
      reason: "Integrity regression opening",
      lines: [{ product_id: p.id, quantity: "2", unit_cost: "50" }],
    });
    return p;
  });
  assert.equal((await transaction(f.actor, verifyIntegrity)).matches, true);
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        await ctx.db.query(
          "DELETE FROM stock_balances WHERE company_id=$1 AND product_id=$2",
          [f.companyId, p.id],
        );
        const report = await verifyIntegrity(ctx);
        assert.equal(report.matches, false);
        assert.equal(report.inventory.movement_discrepancies.length, 1);
        throw new Error("rollback missing-cache probe");
      }),
    /rollback missing-cache probe/,
  );
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        await postJournal(ctx, {
          branchId: f.branchId,
          date: new Date().toISOString().slice(0, 10),
          sourceType: "manual",
          sourceId: randomUUID(),
          description: "Raw control-account corruption probe",
          lines: [
            { account: "ar", debit: "1" },
            { account: "equity", credit: "1" },
          ],
        });
        const report = await verifyIntegrity(ctx);
        assert.equal(
          report.controls.find((c) => c.account === "ar")?.matches,
          false,
        );
        throw new Error("rollback control probe");
      }),
    /rollback control probe/,
  );
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        await ctx.db.query(
          "INSERT INTO warehouses(company_id,branch_id,name,code) VALUES($1,$2,'Unassigned extra store','EXTRA')",
          [f.companyId, f.branchId],
        );
        await verifyIntegrity(ctx);
      }),
    /all warehouses/,
  );
  assert.equal((await transaction(f.actor, verifyIntegrity)).matches, true);
});

test("report defaults use the company calendar and a historical as-of year, not the server UTC calendar", async () => {
  const f = await fixture();
  const { reportScope } = await import(
    "../../apps/api/src/services/reports.ts"
  );
  for (const timezone of [
    "Africa/Nairobi",
    "Pacific/Pago_Pago",
    "Pacific/Kiritimati",
  ]) {
    await transaction(f.actor, async (ctx) => {
      await ctx.db.query("UPDATE companies SET timezone=$1 WHERE id=$2", [
        timezone,
        f.companyId,
      ]);
      const today = (
        await one(
          ctx,
          "SELECT to_char(now() AT TIME ZONE timezone,'YYYY-MM-DD') AS today FROM companies WHERE id=$1",
          [f.companyId],
        )
      ).today;
      const scope = await reportScope(ctx, {});
      assert.equal(scope.to, today);
      assert.equal(scope.from, today.slice(0, 4) + "-01-01");
      assert.equal(
        (await reportScope(ctx, { to: "2025-12-31" })).from,
        "2025-01-01",
      );
      await assert.rejects(
        () => reportScope(ctx, { from: "9999-01-01" }),
        /start date/,
      );
    });
  }
});
