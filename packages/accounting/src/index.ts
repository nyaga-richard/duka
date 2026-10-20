import { D, money, sum } from "@duka/shared";
import { randomUUID } from "node:crypto";
import {
  accountingDate,
  audit,
  branchAccess,
  fail,
  nextNumber,
  one,
  requirePermission,
  type Context,
} from "../../../apps/api/src/db.ts";
export interface PostingLine {
  account: string;
  debit?: string;
  credit?: string;
  customerId?: string;
  supplierId?: string;
  memo?: string;
  byId?: boolean;
}
export function validateJournal(lines: { debit?: string; credit?: string }[]) {
  if (lines.length < 2)
    throw new Error("A journal requires at least two lines");
  for (const l of lines) {
    const dr = D(l.debit ?? 0),
      cr = D(l.credit ?? 0);
    if (
      dr.lt(0) ||
      cr.lt(0) ||
      !dr.eq(dr.toDecimalPlaces(2)) ||
      !cr.eq(cr.toDecimalPlaces(2)) ||
      dr.gt(0) === cr.gt(0)
    )
      throw new Error(
        "Each line must have one positive debit or credit, at currency precision",
      );
  }
  const dr = sum(lines.map((l) => l.debit ?? "0")),
    cr = sum(lines.map((l) => l.credit ?? "0"));
  if (!dr.eq(cr)) throw new Error(`Journal is not balanced: ${dr} / ${cr}`);
  return money(dr);
}
export async function accountId(ctx: Context, key: string) {
  return (
    await one(
      ctx,
      "SELECT id FROM accounts WHERE company_id=$1 AND system_key=$2 AND active",
      [ctx.companyId, key],
    )
  ).id as string;
}
export async function postJournal(
  ctx: Context,
  input: {
    branchId: string;
    date: string;
    sourceType: string;
    sourceId: string;
    description: string;
    lines: PostingLine[];
    reversalOf?: string;
  },
) {
  branchAccess(ctx, input.branchId);
  await accountingDate(ctx, input.date);
  const lines = input.lines.filter(
    (l) => D(l.debit ?? 0).gt(0) || D(l.credit ?? 0).gt(0),
  );
  try {
    validateJournal(lines);
  } catch (e: any) {
    fail(422, "UNBALANCED_JOURNAL", e.message);
  }
  // Opening approval holds this boundary before the company journal counter.
  // Acquire in the same order for debt postings, not first inside INSERT's guard.
  if (
    [
      "sale",
      "sale_return",
      "customer_receipt",
      "supplier_invoice",
      "supplier_payment",
      "supplier_return",
      "supplier_credit_settlement",
      "advance_allocation",
      "opening_allocation",
      "opening_balance",
      "opening_balance_reversal",
    ].includes(input.sourceType)
  )
    await ctx.db.query("SELECT lock_opening_boundary($1,$2)", [
      ctx.companyId,
      input.branchId,
    ]);
  const id = randomUUID(),
    number = await nextNumber(ctx, "JRN");
  await ctx.db.query(
    "INSERT INTO journals(id,company_id,branch_id,number,accounting_date,source_type,source_id,description,created_by,reversal_of) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      id,
      ctx.companyId,
      input.branchId,
      number,
      input.date,
      input.sourceType,
      input.sourceId,
      input.description,
      ctx.actor.id,
      input.reversalOf ?? null,
    ],
  );
  for (const l of lines) {
    const account = l.byId
      ? (
          await one(
            ctx,
            "SELECT id FROM accounts WHERE company_id=$1 AND id=$2 AND active",
            [ctx.companyId, l.account],
          )
        ).id
      : await accountId(ctx, l.account);
    await ctx.db.query(
      "INSERT INTO journal_lines(company_id,journal_id,account_id,debit,credit,customer_id,supplier_id,memo) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        ctx.companyId,
        id,
        account,
        money(l.debit ?? 0),
        money(l.credit ?? 0),
        l.customerId ?? null,
        l.supplierId ?? null,
        l.memo ?? null,
      ],
    );
  }
  await audit(ctx, "post", "journal", id, null, {
    number,
    sourceType: input.sourceType,
    total: money(sum(lines.map((l) => l.debit ?? "0"))),
  });
  return { id, number };
}
export async function reverseJournal(
  ctx: Context,
  id: string,
  date: string,
  reason: string,
) {
  requirePermission(ctx, "accounting.reverse");
  const j = await one(
    ctx,
    "SELECT * FROM journals WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, j.branch_id);
  // Operational sources must use their domain correction workflow, not a GL-only reversal.
  if (!["manual", "opening"].includes(j.source_type))
    fail(
      409,
      "DOMAIN_REVERSAL_REQUIRED",
      "Use the original business document return or correction workflow",
    );
  if (j.reversal_of)
    fail(409, "ALREADY_REVERSAL", "A reversal cannot itself be reversed");
  const old = await ctx.db.query(
    "SELECT id FROM journals WHERE company_id=$1 AND reversal_of=$2",
    [ctx.companyId, id],
  );
  if (old.rowCount) fail(409, "ALREADY_REVERSED", "Journal already reversed");
  const lines = (
    await ctx.db.query(
      "SELECT * FROM journal_lines WHERE company_id=$1 AND journal_id=$2",
      [ctx.companyId, id],
    )
  ).rows;
  const result = await postJournal(ctx, {
    branchId: j.branch_id,
    date,
    sourceType: "reversal",
    sourceId: randomUUID(),
    description: `Reversal of ${j.number}: ${reason}`,
    reversalOf: id,
    lines: lines.map((l) => ({
      account: l.account_id,
      byId: true,
      debit: l.credit,
      credit: l.debit,
      customerId: l.customer_id,
      supplierId: l.supplier_id,
    })),
  });
  await audit(ctx, "reverse", "journal", id, j, result, reason);
  return result;
}
export const chartOfAccounts = [
  ["1000", "Cash on hand", "asset", "cash"],
  ["1010", "M-Pesa clearing", "asset", "mpesa"],
  ["1020", "Bank current account", "asset", "bank"],
  ["1030", "Card clearing", "asset", "card"],
  ["1100", "Accounts receivable", "asset", "ar"],
  ["1150", "Supplier advances", "asset", "supplier_advances"],
  ["1200", "Inventory", "asset", "inventory"],
  ["1300", "VAT recoverable", "asset", "tax_input"],
  ["1400", "Interbranch clearing", "asset", "interbranch"],
  ["1500", "Property, plant & equipment", "asset", "fixed_assets"],
  ["1590", "Accumulated depreciation", "asset", "accumulated_depreciation"],
  ["2000", "Accounts payable", "liability", "ap"],
  ["2050", "Goods received not invoiced", "liability", "grni"],
  ["2100", "VAT payable", "liability", "tax_output"],
  ["2150", "Customer advances", "liability", "customer_advances"],
  ["2200", "Refunds payable", "liability", "refund_payable"],
  ["3000", "Owner capital / opening balances", "equity", "equity"],
  ["3100", "Retained earnings", "equity", "retained_earnings"],
  ["4000", "Sales revenue", "income", "sales"],
  ["4090", "Sales returns", "income", "sales_returns"],
  ["4950", "Gain on disposal of assets", "income", "asset_disposal_gain"],
  ["5000", "Cost of goods sold", "expense", "cogs"],
  ["5100", "Stock loss and damage", "expense", "stock_loss"],
  ["5150", "Purchase price variance", "expense", "purchase_variance"],
  ["6000", "Operating expenses", "expense", "expenses"],
  ["6100", "Cash over / short", "expense", "cash_variance"],
  ["6200", "Depreciation expense", "expense", "depreciation"],
  ["6300", "Loss on disposal of assets", "expense", "asset_disposal_loss"],
] as const;
