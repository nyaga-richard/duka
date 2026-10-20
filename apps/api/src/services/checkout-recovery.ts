import {
  lockIdempotency,
  requirePermission,
  one,
  branchAccess,
  warehouseAccess,
  fail,
  audit,
  type Context,
} from "../db.ts";
const operation = "post:/sales";
export async function cancelUncertainCheckout(
  ctx: Context,
  input: { key: string; reason: string },
) {
  requirePermission(ctx, "sales.create");
  await lockIdempotency(ctx, operation, input.key);
  const old = (
    await ctx.db.query(
      "SELECT actor_id,response FROM idempotency_keys WHERE company_id=$1 AND operation=$2 AND key=$3",
      [ctx.companyId, operation, input.key],
    )
  ).rows[0];
  if (old) {
    if (old.actor_id !== ctx.actor.id)
      fail(
        409,
        "IDEMPOTENCY_ACTOR",
        "This command belongs to another authenticated user",
      );
    const sale = await one(
      ctx,
      "SELECT id,number,total,branch_id,warehouse_id FROM sales WHERE company_id=$1 AND id=$2",
      [ctx.companyId, old.response.id],
    );
    branchAccess(ctx, sale.branch_id);
    await warehouseAccess(ctx, sale.warehouse_id);
    await audit(
      ctx,
      "recover",
      "sale",
      sale.id,
      null,
      { key: input.key },
      input.reason,
    );
    return {
      status: "posted" as const,
      sale: { id: sale.id, number: sale.number, total: sale.total },
    };
  }
  const cancelled = (
    await ctx.db.query(
      "SELECT actor_id FROM cancelled_commands WHERE company_id=$1 AND operation=$2 AND key=$3",
      [ctx.companyId, operation, input.key],
    )
  ).rows[0];
  if (cancelled && cancelled.actor_id !== ctx.actor.id)
    fail(
      409,
      "IDEMPOTENCY_ACTOR",
      "This command belongs to another authenticated user",
    );
  if (!cancelled) {
    await ctx.db.query(
      "INSERT INTO cancelled_commands(company_id,operation,key,actor_id,reason) VALUES($1,$2,$3,$4,$5)",
      [ctx.companyId, operation, input.key, ctx.actor.id, input.reason],
    );
    await audit(
      ctx,
      "cancel_unposted",
      "checkout",
      null,
      null,
      { key: input.key },
      input.reason,
    );
  }
  return { status: "cancelled" as const };
}
