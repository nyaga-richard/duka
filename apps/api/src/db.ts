import "dotenv/config";
import pg from "pg";
import type { PoolClient } from "pg";
import { randomUUID, createHash } from "node:crypto";
// Validate driver parsing without connecting; never let a malformed URL's
// credential-bearing `input` field escape in an uncaught Node error dump.
if (process.env.DATABASE_URL) {
  try {
    new pg.Client({ connectionString: process.env.DATABASE_URL });
  } catch {
    throw new Error(
      "DATABASE_URL could not be parsed; verify its format without logging credentials",
    );
  }
}
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  application_name: "duka-api",
});
pool.on("error", (e) => console.error("database pool error", e.message));
export interface Actor {
  id: string;
  company_id: string;
  name: string;
  email: string;
  permissions: string[];
  branch_ids: string[];
  warehouse_ids: string[];
  approval_limit: string;
  session_id?: string;
  csrf_token?: string;
}
export interface Context {
  db: PoolClient;
  actor: Actor;
  businessToday?: string;
  companyId: string;
  requestId: string;
  branchId?: string;
  onRollback: (task: () => Promise<void>) => void;
}
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function fail(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): never {
  throw new AppError(status, code, message, details);
}
export async function transaction<T>(
  actor: Actor,
  fn: (ctx: Context) => Promise<T>,
  requestId = randomUUID(),
  options: { isolation?: "repeatable read"; readOnly?: boolean } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const db = await pool.connect();
    const rollbackTasks: Array<() => Promise<void>> = [];
    let committing = false;
    try {
      await db.query(
        "BEGIN" +
          (options.isolation ? " ISOLATION LEVEL REPEATABLE READ" : "") +
          (options.readOnly ? " READ ONLY" : ""),
      );
      await db.query(
        "SELECT set_config('app.company_id',$1,true),set_config('app.actor_id',$2,true),set_config('statement_timeout','15000',true),set_config('lock_timeout','8000',true)",
        [actor.company_id, actor.id],
      );
      const result = await fn({
        db,
        actor,
        companyId: actor.company_id,
        requestId,
        onRollback: (task) => rollbackTasks.push(task),
      });
      committing = true;
      await db.query("COMMIT");
      return result;
    } catch (e: any) {
      await db.query("ROLLBACK").catch(() => {});
      // A lost COMMIT response is ambiguous: retain immutable files rather than
      // deleting a file that a committed metadata row may reference.
      if (
        !committing ||
        ["40001", "40P01", "23514", "23503", "23505", "25P02"].includes(e.code)
      )
        for (const task of rollbackTasks)
          try {
            await task();
          } catch (cleanupError) {
            console.error(
              "attachment rollback cleanup requires operator review",
              cleanupError,
            );
          }
      if (["40001", "40P01"].includes(e.code) && attempt < 2) continue;
      throw e;
    } finally {
      db.release();
    }
  }
}
export const has = (ctx: Context, p: string) =>
  ctx.actor.permissions.includes(p);
export const canReadCosts = (ctx: Context) =>
  ["catalog.write", "inventory.read", "accounting.read", "purchases.read"].some(
    (p) => has(ctx, p),
  );
export function redactCosts(ctx: Context, row: any) {
  if (canReadCosts(ctx)) return row;
  const copy = { ...row };
  for (const field of [
    "purchase_cost",
    "average_cost",
    "stock_value",
    "cost",
    "unit_cost",
  ])
    delete copy[field];
  if (Array.isArray(copy.components))
    copy.components = copy.components.map((v: any) => {
      const c = { ...v };
      for (const field of ["value", "unit_cost", "cost", "return_value"])
        delete c[field];
      return c;
    });
  return copy;
}
export function requirePermission(ctx: Context, p: string) {
  if (!has(ctx, p)) fail(403, "FORBIDDEN", `Permission required: ${p}`);
}
export function requireOneOf(ctx: Context, permissions: string[]) {
  if (!permissions.some((p) => has(ctx, p)))
    fail(
      403,
      "FORBIDDEN",
      `One of these permissions is required: ${permissions.join(", ")}`,
    );
}
export async function requireAllBranches(ctx: Context) {
  const missing = await ctx.db.query(
    "SELECT 1 FROM branches WHERE company_id=$1 AND NOT(id=ANY($2::uuid[])) LIMIT 1",
    [ctx.companyId, ctx.actor.branch_ids],
  );
  if (missing.rowCount)
    fail(
      403,
      "ALL_BRANCHES_REQUIRED",
      "This company-wide operation requires access to every branch",
    );
}
export function branchAccess(ctx: Context, id: string) {
  if (!ctx.actor.branch_ids.includes(id))
    fail(403, "BRANCH_FORBIDDEN", "This branch is not assigned to you");
  ctx.branchId = id;
}
export async function warehouseAccess(ctx: Context, id: string) {
  const w = await one(
    ctx,
    "SELECT * FROM warehouses WHERE company_id=$1 AND id=$2 AND active",
    [ctx.companyId, id],
  );
  branchAccess(ctx, w.branch_id);
  if (!ctx.actor.warehouse_ids.includes(id))
    fail(403, "WAREHOUSE_FORBIDDEN", "This warehouse is not assigned to you");
  return w;
}
export async function one(
  ctx: Context,
  sql: string,
  params: unknown[] = [],
): Promise<any> {
  const r = await ctx.db.query(sql, params);
  return r.rows[0] ?? fail(404, "NOT_FOUND", "Record not found");
}
export async function audit(
  ctx: Context,
  action: string,
  entity: string,
  id: string | null,
  before: unknown = null,
  after: unknown = null,
  reason: string | null = null,
) {
  await ctx.db.query(
    "INSERT INTO audit_logs(company_id,actor_id,action,entity,record_id,before_value,after_value,reason,correlation_id,branch_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      ctx.companyId,
      ctx.actor.id,
      action,
      entity,
      id,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      reason,
      ctx.requestId,
      ctx.branchId ?? null,
    ],
  );
}
export async function nextNumber(ctx: Context, kind: string) {
  const r = await ctx.db.query(
    "INSERT INTO sequences(company_id,kind,value) VALUES($1,$2,1) ON CONFLICT(company_id,kind) DO UPDATE SET value=sequences.value+1 RETURNING value",
    [ctx.companyId, kind],
  );
  return `${kind}-${String(r.rows[0].value).padStart(7, "0")}`;
}
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const authorizationScope = (ctx: Context) =>
  digest(
    canonical({
      permissions: [...ctx.actor.permissions].sort(),
      branches: [...ctx.actor.branch_ids].sort(),
      warehouses: [...ctx.actor.warehouse_ids].sort(),
    }),
  );
export async function lockIdempotency(
  ctx: Context,
  operation: string,
  key: string | undefined,
) {
  if (!key || key.length < 8 || key.length > 160)
    fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Supply an Idempotency-Key of 8–160 characters",
    );
  await ctx.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${ctx.companyId}:${operation}:${key}`,
  ]);
}
export async function idempotent<T>(
  ctx: Context,
  operation: string,
  key: string | undefined,
  payload: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  if (!key || key.length < 8 || key.length > 160)
    fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Supply an Idempotency-Key of 8–160 characters",
    );
  const hash = digest(canonical(payload));
  await lockIdempotency(ctx, operation, key);
  if (operation === "post:/sales") {
    const cancelled = (
      await ctx.db.query(
        "SELECT actor_id FROM cancelled_commands WHERE company_id=$1 AND operation=$2 AND key=$3",
        [ctx.companyId, operation, key],
      )
    ).rows[0];
    if (cancelled) {
      if (cancelled.actor_id !== ctx.actor.id)
        fail(
          409,
          "IDEMPOTENCY_ACTOR",
          "This key belongs to another authenticated user",
        );
      fail(
        409,
        "COMMAND_CANCELLED",
        "This unposted checkout was permanently cancelled; use a new intention/key for a corrected draft",
      );
    }
  }
  const old = (
    await ctx.db.query(
      "SELECT * FROM idempotency_keys WHERE company_id=$1 AND operation=$2 AND key=$3",
      [ctx.companyId, operation, key],
    )
  ).rows[0];
  if (old) {
    if (old.actor_id && old.actor_id !== ctx.actor.id)
      fail(
        409,
        "IDEMPOTENCY_ACTOR",
        "This key belongs to another authenticated user",
      );
    if (old.authorization_scope !== authorizationScope(ctx))
      fail(
        409,
        "IDEMPOTENCY_SCOPE_CHANGED",
        "Access scope changed or this is a legacy command. Reconcile the original resource; do not create a replacement.",
      );
    if (old.request_hash !== hash)
      fail(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This key was already used with different data",
      );
    return old.response as T;
  }
  const result = await fn();
  await ctx.db.query(
    "INSERT INTO idempotency_keys(company_id,operation,key,request_hash,response,actor_id,authorization_scope) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      ctx.companyId,
      operation,
      key,
      hash,
      JSON.stringify(result),
      ctx.actor.id,
      authorizationScope(ctx),
    ],
  );
  return result;
}
export async function accountingDate(ctx: Context, input?: string) {
  const c = await one(ctx, "SELECT timezone FROM companies WHERE id=$1", [
    ctx.companyId,
  ]);
  const today = (
    await ctx.db.query(
      "SELECT to_char(now() AT TIME ZONE $1,'YYYY-MM-DD') AS d",
      [c.timezone],
    )
  ).rows[0].d;
  const d = input ?? today;
  if (d !== today && d < today && !has(ctx, "accounting.post"))
    fail(
      403,
      "BACKDATE_PERMISSION",
      "Backdating requires accounting.post permission",
    );
  if (d > today)
    fail(422, "FUTURE_DATE", "Future accounting dates are not permitted");
  const open = await ctx.db.query(
    "SELECT id FROM accounting_periods WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date AND status='open' FOR SHARE",
    [ctx.companyId, d],
  );
  if (!open.rowCount)
    fail(409, "PERIOD_CLOSED", "No open accounting period for this date");
  await ctx.db.query("SELECT set_config('app.accounting_date',$1,true)", [d]);
  return d;
}
export function uniqueIds(
  ids: string[],
  message = "Duplicate lines are not allowed",
) {
  if (new Set(ids).size !== ids.length) fail(422, "DUPLICATE_LINES", message);
}
export const pageArgs = (query: any) => {
  const page = Math.max(1, Math.min(100000, Number(query.page) || 1)),
    limit = Math.max(1, Math.min(100, Number(query.limit) || 25));
  return { page, limit, offset: (page - 1) * limit };
};
