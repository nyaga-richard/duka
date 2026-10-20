import "dotenv/config";
import { randomUUID } from "node:crypto";
import { permissions } from "@duka/shared";
import { pool, transaction, type Actor } from "../apps/api/src/db.ts";
import { verifyIntegrity } from "../apps/api/src/services/integrity.ts";
export async function reconcileAll(
  companyId = process.env.RECONCILE_COMPANY_ID,
) {
  if (companyId && !/^[0-9a-f-]{36}$/i.test(companyId))
    throw new Error("Invalid RECONCILE_COMPANY_ID");
  // Operator-only DB command. No credentials or synthetic authority are exposed to HTTP clients.
  const companies = (
    await pool.query(
      "SELECT DISTINCT ON(company_id) id,company_id,email,name FROM identities WHERE ($1::uuid IS NULL OR company_id=$1) ORDER BY company_id,created_at",
      [companyId || null],
    )
  ).rows;
  if (!companies.length) throw new Error("No companies found");
  const results = [];
  for (const user of companies) {
    const actor: Actor = {
      ...user,
      permissions: [...permissions],
      branch_ids: [],
      warehouse_ids: [],
      approval_limit: "0",
    };
    const result = await transaction(
      actor,
      async (ctx) => {
        ctx.actor.branch_ids = (
          await ctx.db.query("SELECT id FROM branches WHERE company_id=$1", [
            ctx.companyId,
          ])
        ).rows.map((r) => r.id);
        ctx.actor.warehouse_ids = (
          await ctx.db.query("SELECT id FROM warehouses WHERE company_id=$1", [
            ctx.companyId,
          ])
        ).rows.map((r) => r.id);
        return verifyIntegrity(ctx);
      },
      randomUUID(),
      { isolation: "repeatable read", readOnly: true },
    );
    results.push(result);
  }
  return { matches: results.every((r) => r.matches), companies: results };
}
if (/\/reconcile\.(ts|mjs)$/.test(process.argv[1] ?? "")) {
  try {
    const report = await reconcileAll();
    console.log(JSON.stringify(report, null, 2));
    if (!report.matches) process.exitCode = 1;
  } catch (e: any) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
