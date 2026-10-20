import { D, money, sum } from "@duka/shared";
import { fail, one, branchAccess, type Context } from "../db.ts";
export async function createAdvance(
  ctx: Context,
  input: {
    kind: "customer" | "supplier";
    contactId: string;
    branchId: string;
    sourceType: string;
    sourceId: string;
    amount: string;
    date: string;
  },
) {
  if (!D(input.amount).gt(0)) return;
  await ctx.db.query(
    `INSERT INTO advance_credits(company_id,branch_id,${input.kind}_id,source_type,source_id,amount,accounting_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      ctx.companyId,
      input.branchId,
      input.contactId,
      input.sourceType,
      input.sourceId,
      input.amount,
      input.date,
      ctx.actor.id,
    ],
  );
}
export async function consumeAdvance(
  ctx: Context,
  input: {
    kind: "customer" | "supplier";
    contactId: string;
    branchId: string;
    targetType: string;
    targetId: string;
    amount: string;
    date: string;
    sourceId?: string;
    creditId?: string;
  },
) {
  if (!D(input.amount).gt(0)) return;
  branchAccess(ctx, input.branchId);
  await one(
    ctx,
    `SELECT id FROM ${input.kind === "customer" ? "customers" : "suppliers"} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
    [ctx.companyId, input.contactId],
  );
  const rows = (
    await ctx.db.query(
      `SELECT c.*,(c.amount-coalesce((SELECT sum(u.amount) FROM advance_uses u WHERE u.company_id=c.company_id AND u.credit_id=c.id),0))::text AS available FROM advance_credits c WHERE c.company_id=$1 AND c.${input.kind}_id=$2 AND c.branch_id=$3 AND c.accounting_date<=$4 AND ($5::uuid IS NULL OR c.source_id=$5) AND ($6::uuid IS NULL OR c.id=$6) ORDER BY c.accounting_date,c.created_at,c.id FOR UPDATE`,
      [
        ctx.companyId,
        input.contactId,
        input.branchId,
        input.date,
        input.sourceId ?? null,
        input.creditId ?? null,
      ],
    )
  ).rows;
  if (sum(rows.map((r) => r.available)).lt(input.amount))
    fail(
      409,
      "ADVANCE_INSUFFICIENT",
      "Insufficient unapplied credit available on this accounting date",
    );
  let remaining = D(input.amount);
  for (const row of rows) {
    if (remaining.eq(0)) break;
    const use = D(row.available).lt(remaining) ? D(row.available) : remaining;
    if (use.lte(0)) continue;
    await ctx.db.query(
      "INSERT INTO advance_uses(company_id,credit_id,target_type,target_id,amount,accounting_date) VALUES($1,$2,$3,$4,$5,$6)",
      [
        ctx.companyId,
        row.id,
        input.targetType,
        input.targetId,
        money(use),
        input.date,
      ],
    );
    remaining = remaining.minus(use);
  }
}
