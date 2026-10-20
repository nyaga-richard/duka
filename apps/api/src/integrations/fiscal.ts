import {
  pool,
  transaction,
  one,
  fail,
  audit,
  requirePermission,
  branchAccess,
  type Context,
} from "../db.ts";
import { integrationActor } from "./mpesa.ts";
export async function enqueueFiscal(
  ctx: Context,
  sourceType: string,
  sourceId: string,
) {
  const status = process.env.ETIMS_MODE === "adapter" ? "pending" : "disabled";
  const row = (
    await ctx.db.query(
      "INSERT INTO fiscal_submissions(company_id,source_type,source_id,status) VALUES($1,$2,$3,$4) RETURNING id",
      [ctx.companyId, sourceType, sourceId, status],
    )
  ).rows[0];
  if (status === "pending")
    await ctx.db.query(
      "INSERT INTO fiscal_dispatch(company_id,actor_id,submission_id) VALUES($1,$2,$3)",
      [ctx.companyId, ctx.actor.id, row.id],
    );
  return row;
}
export interface FiscalAdapter {
  submit(
    payload: unknown,
    key: string,
  ): Promise<{ status: "successful"; fiscal_id: string; receipt_url?: string }>;
}
export class CertifiedGatewayAdapter implements FiscalAdapter {
  async submit(payload: unknown, key: string) {
    const url = process.env.ETIMS_ADAPTER_URL,
      token = process.env.ETIMS_ADAPTER_TOKEN;
    if (!url?.startsWith("https://") || !token)
      throw new Error(
        "Certified HTTPS eTIMS gateway and credentials are not configured",
      );
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok)
      throw new Error(`Fiscal gateway rejected submission (${r.status})`);
    const body: any = await r.json();
    if (
      body.status !== "successful" ||
      typeof body.fiscal_id !== "string" ||
      body.fiscal_id.length < 1
    )
      throw new Error(
        "Fiscal gateway did not return a confirmed fiscal identifier",
      );
    return {
      status: "successful" as const,
      fiscal_id: body.fiscal_id,
      receipt_url:
        typeof body.receipt_url === "string" ? body.receipt_url : undefined,
    };
  }
}
export async function processFiscalJob(
  jobId: string,
  adapter: FiscalAdapter = new CertifiedGatewayAdapter(),
) {
  const job = (
    await pool.query("SELECT * FROM fiscal_dispatch WHERE id=$1", [jobId])
  ).rows[0];
  if (!job || job.status === "successful") return;
  const actor = await integrationActor(job.company_id, job.actor_id);
  try {
    const payload = await transaction(actor, async (ctx) => {
      const s = await one(
        ctx,
        "SELECT * FROM fiscal_submissions WHERE company_id=$1 AND id=$2 FOR UPDATE",
        [ctx.companyId, job.submission_id],
      );
      if (s.status === "successful") return null;
      const table = s.source_type === "sale" ? "sales" : "sale_returns";
      const doc = await one(
        ctx,
        `SELECT * FROM ${table} WHERE company_id=$1 AND id=$2`,
        [ctx.companyId, s.source_id],
      );
      branchAccess(ctx, doc.branch_id);
      const lines = (
        await ctx.db.query(
          `SELECT * FROM ${s.source_type === "sale" ? "sale_lines" : "sale_return_lines"} WHERE company_id=$1 AND ${s.source_type === "sale" ? "sale_id" : "return_id"}=$2`,
          [ctx.companyId, doc.id],
        )
      ).rows;
      const company = await one(
        ctx,
        "SELECT name,tax_pin,currency FROM companies WHERE id=$1",
        [ctx.companyId],
      );
      await ctx.db.query(
        "UPDATE fiscal_submissions SET status='processing',attempts=attempts+1 WHERE company_id=$1 AND id=$2",
        [ctx.companyId, s.id],
      );
      return {
        schema_version: 1,
        source_type: s.source_type,
        source_id: s.source_id,
        company,
        document: doc,
        lines,
      };
    });
    if (!payload) return;
    const result = await adapter.submit(
      payload,
      `${job.company_id}:${payload.source_type}:${payload.source_id}`,
    );
    await transaction(actor, async (ctx) => {
      await ctx.db.query(
        "UPDATE fiscal_submissions SET status='successful',fiscal_id=$1,response=$2,error=NULL WHERE company_id=$3 AND id=$4",
        [
          result.fiscal_id,
          JSON.stringify(result),
          ctx.companyId,
          job.submission_id,
        ],
      );
      await ctx.db.query(
        "UPDATE fiscal_dispatch SET status='successful',last_error=NULL WHERE id=$1",
        [job.id],
      );
      await audit(
        ctx,
        "background.fiscal_confirmed",
        "fiscal_submission",
        job.submission_id,
        null,
        { fiscal_id: result.fiscal_id },
      );
    });
  } catch (e: any) {
    await transaction(actor, (ctx) =>
      ctx.db.query(
        "UPDATE fiscal_submissions SET status='failed',error=$1 WHERE company_id=$2 AND id=$3",
        [e.message.slice(0, 1000), ctx.companyId, job.submission_id],
      ),
    );
    throw e;
  }
}
export async function retryFiscal(ctx: Context, id: string) {
  requirePermission(ctx, "integrations.manage");
  if (process.env.ETIMS_MODE !== "adapter")
    fail(409, "FISCAL_DISABLED", "Configure a certified adapter first");
  const s = await one(
    ctx,
    "SELECT * FROM fiscal_submissions WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  if (s.status === "successful")
    fail(
      409,
      "FISCAL_ALREADY_CONFIRMED",
      "Successful fiscal submissions cannot be resent",
    );
  const table = s.source_type === "sale" ? "sales" : "sale_returns";
  const doc = await one(
    ctx,
    `SELECT branch_id FROM ${table} WHERE company_id=$1 AND id=$2`,
    [ctx.companyId, s.source_id],
  );
  branchAccess(ctx, doc.branch_id);
  await ctx.db.query(
    "UPDATE fiscal_submissions SET status='pending',error=NULL WHERE company_id=$1 AND id=$2",
    [ctx.companyId, id],
  );
  await ctx.db.query(
    "INSERT INTO fiscal_dispatch(company_id,actor_id,submission_id) VALUES($1,$2,$3) ON CONFLICT(submission_id) DO UPDATE SET status='pending',attempts=0,next_attempt_at=now(),actor_id=EXCLUDED.actor_id",
    [ctx.companyId, ctx.actor.id, id],
  );
  await audit(ctx, "retry", "fiscal_submission", id);
  return { id, status: "pending" };
}
