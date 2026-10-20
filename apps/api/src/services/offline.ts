import { D, checkoutSchema, type CheckoutInput } from "@duka/shared";
import {
  one,
  fail,
  requirePermission,
  accountingDate,
  branchAccess,
  audit,
  digest,
  type Context,
  AppError,
} from "../db.ts";
import { checkout } from "./sales.ts";
export async function catalogVersion(ctx: Context) {
  return (
    await ctx.db.query(
      "SELECT md5(coalesce(string_agg(concat_ws(':',p.id,p.updated_at,p.price,t.rate,t.valid_from,t.valid_to,t.active),',' ORDER BY p.id),'')) AS version FROM products p JOIN tax_rules t ON t.company_id=p.company_id AND t.id=p.tax_rule_id WHERE p.company_id=$1",
      [ctx.companyId],
    )
  ).rows[0].version as string;
}
export async function syncSale(
  ctx: Context,
  input: {
    client_id: string;
    device_id: string;
    catalog_version: string;
    captured_at: string;
    captured_shift_id?: string;
    accept_changes: boolean;
    sale: CheckoutInput;
  },
) {
  requirePermission(ctx, "sales.create");
  const device = await one(
    ctx,
    "SELECT * FROM offline_devices WHERE company_id=$1 AND id=$2 AND user_id=$3 AND active",
    [ctx.companyId, input.device_id, ctx.actor.id],
  );
  const register = await one(
    ctx,
    "SELECT * FROM registers WHERE company_id=$1 AND id=$2 AND active",
    [ctx.companyId, device.register_id],
  );
  branchAccess(ctx, register.branch_id);
  if (input.sale.register_id !== register.id)
    fail(
      422,
      "OFFLINE_REGISTER_MISMATCH",
      "Offline capture belongs to a different register",
    );
  if (
    input.sale.customer_id ||
    D(input.sale.customer_credit).gt(0) ||
    D(input.sale.discount_percent).gt(0) ||
    input.sale.order_id ||
    input.sale.price_list_id ||
    input.sale.lines.some(
      (l) => l.unit_price !== undefined || D(l.discount_percent ?? 0).gt(0),
    )
  )
    fail(
      422,
      "OFFLINE_POLICY",
      "Offline capture permits standard-price walk-in cash sales only; no credit, manual discounts, price overrides, or order conversion",
    );
  for (const p of input.sale.payments) {
    const m = await one(
      ctx,
      "SELECT kind FROM payment_methods WHERE company_id=$1 AND id=$2",
      [ctx.companyId, p.method_id],
    );
    if (m.kind !== "cash" || p.intent_id)
      fail(
        422,
        "OFFLINE_PAYMENT_UNCONFIRMED",
        "Offline mobile money, card and bank payments cannot be confirmed",
      );
  }
  const core = digest(
    JSON.stringify({
      device: input.device_id,
      sale: input.sale,
      captured_at: input.captured_at,
      ...(input.captured_shift_id
        ? { captured_shift_id: input.captured_shift_id }
        : {}),
    }),
  );
  await ctx.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    ctx.companyId + ":sync:" + input.client_id,
  ]);
  const old = (
    await ctx.db.query(
      "SELECT * FROM sync_records WHERE company_id=$1 AND client_id=$2 FOR UPDATE",
      [ctx.companyId, input.client_id],
    )
  ).rows[0];
  if (old) {
    if (old.user_id !== ctx.actor.id || old.request_hash !== core)
      fail(
        409,
        "SYNC_ID_REUSED",
        "This client transaction ID was already used for different data",
      );
    if (old.status === "posted")
      return { status: "posted", sale_id: old.sale_id, duplicate: true };
  }
  await ctx.db.query("SAVEPOINT offline_post");
  try {
    const age = Date.now() - new Date(input.captured_at).getTime();
    if (age < -60000 || age > 24 * 60 * 60 * 1000)
      fail(
        409,
        "OFFLINE_CAPTURE_EXPIRED",
        "Captures older than 24 hours or from a future clock require manager review and online re-entry",
      );
    if (!input.captured_shift_id)
      fail(
        409,
        "OFFLINE_SHIFT_REQUIRED",
        "Legacy capture lacks an original shift identifier; reconcile with a manager rather than rebinding it to a new drawer",
      );
    await accountingDate(ctx, input.sale.accounting_date);
    const shift = await one(
      ctx,
      "SELECT id,opened_at FROM shifts WHERE company_id=$1 AND register_id=$2 AND cashier_id=$3 AND status IN ('open','rejected') FOR UPDATE",
      [ctx.companyId, register.id, ctx.actor.id],
    );
    if (
      shift.id !== input.captured_shift_id ||
      new Date(input.captured_at).getTime() <
        new Date(shift.opened_at).getTime() - 60000
    )
      fail(
        409,
        "OFFLINE_SHIFT_CHANGED",
        "Original captured shift is no longer the current open drawer; manager reconciliation is required",
      );
    const version = await catalogVersion(ctx);
    if (input.catalog_version !== version && !input.accept_changes)
      fail(
        409,
        "OFFLINE_CATALOG_CHANGED",
        "Prices or tax configuration changed; review current prices before explicitly accepting changes",
      );
    const result = await checkout(ctx, input.sale);
    if (D(result.total).gt(device.max_sale_amount))
      fail(
        409,
        "OFFLINE_AMOUNT_LIMIT",
        "Offline capture exceeds the device limit",
      );
    await ctx.db.query("RELEASE SAVEPOINT offline_post");
    await ctx.db.query(
      "INSERT INTO sync_records(company_id,client_id,device_id,user_id,status,sale_id,request_hash) VALUES($1,$2,$3,$4,'posted',$5,$6) ON CONFLICT(company_id,client_id) DO UPDATE SET status='posted',sale_id=EXCLUDED.sale_id,error=NULL",
      [
        ctx.companyId,
        input.client_id,
        input.device_id,
        ctx.actor.id,
        result.id,
        core,
      ],
    );
    await audit(ctx, "synchronize", "sale", result.id, null, {
      client_id: input.client_id,
      device_id: input.device_id,
      captured_at: input.captured_at,
      accepted_changes: input.accept_changes,
    });
    return { status: "posted", sale_id: result.id, sale: result };
  } catch (e) {
    await ctx.db.query("ROLLBACK TO SAVEPOINT offline_post");
    await ctx.db.query("RELEASE SAVEPOINT offline_post");
    if (!(e instanceof AppError)) throw e;
    const error = { code: e.code, message: e.message, details: e.details };
    await ctx.db.query(
      "INSERT INTO sync_records(company_id,client_id,device_id,user_id,status,error,request_hash) VALUES($1,$2,$3,$4,'conflict',$5,$6) ON CONFLICT(company_id,client_id) DO UPDATE SET error=EXCLUDED.error",
      [
        ctx.companyId,
        input.client_id,
        input.device_id,
        ctx.actor.id,
        JSON.stringify(error),
        core,
      ],
    );
    await audit(
      ctx,
      "sync_conflict",
      "sync_record",
      input.client_id,
      null,
      error,
    );
    return { status: "conflict", client_id: input.client_id, error };
  }
}
