import { D, money, Decimal } from "@duka/shared";
import { randomUUID } from "node:crypto";
import {
  one,
  fail,
  requirePermission,
  branchAccess,
  accountingDate,
  nextNumber,
  audit,
  type Context,
} from "../db.ts";
import { recordPayment, validateShift } from "./payments.ts";
import { checkApproval } from "./shifts.ts";
import { postJournal, type PostingLine } from "@duka/accounting";
type Payment = { method_id: string; reference?: string; intent_id?: string };
type RefundInput = {
  amount: string;
  payment: Payment;
  shift_id?: string;
  reason: string;
  accounting_date?: string;
};
async function lockExpense(ctx: Context, id: string, shiftId?: string) {
  const hint = await one(
    ctx,
    "SELECT branch_id,status FROM expenses WHERE company_id=$1 AND id=$2",
    [ctx.companyId, id],
  );
  branchAccess(ctx, hint.branch_id);
  if (hint.status !== "posted")
    fail(
      409,
      "EXPENSE_NOT_POSTED",
      "Only an actually paid, posted expense can be refunded",
    );
  if (shiftId) await validateShift(ctx, shiftId, hint.branch_id);
  return one(
    ctx,
    "SELECT e.*,e.accounting_date::text AS request_date FROM expenses e WHERE e.company_id=$1 AND e.id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
}
async function totals(ctx: Context, id: string) {
  return one(
    ctx,
    "SELECT coalesce(sum(CASE WHEN kind='refund' THEN amount ELSE -amount END),0)::text AS amount,coalesce(sum(CASE WHEN kind='refund' THEN net ELSE -net END),0)::text AS net,coalesce(sum(CASE WHEN kind='refund' THEN tax ELSE -tax END),0)::text AS tax FROM expense_refunds WHERE company_id=$1 AND expense_id=$2",
    [ctx.companyId, id],
  );
}
async function originalPosting(ctx: Context, e: any) {
  const journal = await one(
    ctx,
    "SELECT id,accounting_date::text AS date FROM journals WHERE company_id=$1 AND source_type='expense' AND source_id=$2",
    [ctx.companyId, e.id],
  );
  const lines = (
    await ctx.db.query(
      "SELECT l.account_id,l.debit::text,a.type,a.system_key FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND l.journal_id=$2 AND l.debit>0",
      [ctx.companyId, journal.id],
    )
  ).rows;
  const expense = lines.filter(
      (l) => l.type === "expense" && D(l.debit).eq(e.net),
    ),
    tax = lines.filter(
      (l) => l.system_key === "tax_input" && D(l.debit).eq(e.tax),
    );
  if (expense.length !== 1 || (D(e.tax).gt(0) && tax.length !== 1))
    fail(
      409,
      "EXPENSE_POSTING_RECONCILIATION",
      "Original expense/tax posting needs accountant reconciliation; category edits must not redirect a historical refund",
    );
  return {
    journal,
    expense_account_id: expense[0].account_id,
    tax_account_id: D(e.tax).gt(0) ? tax[0].account_id : null,
  };
}
async function dateOrder(
  ctx: Context,
  e: any,
  postedDate: string,
  date: string,
) {
  const latest = await one(
    ctx,
    "SELECT greatest($3::date,$4::date,max(accounting_date))::text AS date FROM expense_refunds WHERE company_id=$1 AND expense_id=$2",
    [ctx.companyId, e.id, e.request_date, postedDate],
  );
  if (date < latest.date)
    fail(
      409,
      "EXPENSE_REFUND_DATE_ORDER",
      "Expense refund/repayment cannot precede its original posting or related refund activity",
    );
}
async function insert(ctx: Context, data: any) {
  await ctx.db.query(
    "INSERT INTO expense_refunds(id,company_id,expense_id,branch_id,number,kind,reversal_of,amount,net,tax,expense_account_id,tax_account_id,payment_id,accounting_date,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
    [
      data.id,
      ctx.companyId,
      data.expense_id,
      data.branch_id,
      data.number,
      data.kind,
      data.reversal_of ?? null,
      data.amount,
      data.net,
      data.tax,
      data.expense_account_id,
      data.tax_account_id ?? null,
      data.payment_id,
      data.accounting_date,
      data.reason,
      ctx.actor.id,
    ],
  );
}
export async function refundExpense(
  ctx: Context,
  id: string,
  input: RefundInput,
) {
  requirePermission(ctx, "expenses.pay");
  requirePermission(ctx, "expenses.approve");
  const date = await accountingDate(ctx, input.accounting_date),
    e = await lockExpense(ctx, id, input.shift_id),
    used = await totals(ctx, id),
    amount = money(input.amount);
  if (!D(input.amount).eq(amount) || !D(amount).gt(0))
    fail(
      422,
      "EXPENSE_REFUND_AMOUNT",
      "Use a positive refund at currency precision",
    );
  if (D(amount).gt(D(e.total).minus(used.amount)))
    fail(
      409,
      "EXPENSE_OVER_REFUND",
      "Refund exceeds the remaining paid expense",
    );
  const original = await originalPosting(ctx, e);
  await dateOrder(ctx, e, original.journal.date, date);
  await checkApproval(ctx, e.created_by, amount, input.reason);
  // Original VAT proportions, capped by remaining balances. Final depletion clears
  // all rounding remainder; arbitrary earlier refund reversals cannot cause a
  // negative tax component or over-credit either original account.
  const remainingNet = D(e.net).minus(used.net),
    remainingTax = D(e.tax).minus(used.tax),
    guess = D(money(D(amount).times(e.net).div(e.total))),
    lower = Decimal.max(0, D(amount).minus(remainingTax)),
    upper = Decimal.min(amount, remainingNet),
    net = money(Decimal.max(lower, Decimal.min(guess, upper))),
    tax = money(D(amount).minus(net));
  const refundId = randomUUID(),
    number = await nextNumber(ctx, "ERF");
  const payment = await recordPayment(
    ctx,
    { ...input.payment, amount },
    {
      branchId: e.branch_id,
      shiftId: input.shift_id,
      sourceType: "expense_refund",
      sourceId: refundId,
      direction: "in",
      date,
    },
  );
  await insert(ctx, {
    id: refundId,
    expense_id: e.id,
    branch_id: e.branch_id,
    number,
    kind: "refund",
    amount,
    net,
    tax,
    expense_account_id: original.expense_account_id,
    tax_account_id: original.tax_account_id,
    payment_id: payment.id,
    accounting_date: date,
    reason: input.reason,
  });
  const lines: PostingLine[] = [
    { account: payment.account, byId: true, debit: amount },
    {
      account: original.expense_account_id,
      byId: true,
      credit: net,
      memo: `Refund of ${e.number}`,
    },
  ];
  if (D(tax).gt(0))
    lines.push({ account: original.tax_account_id, byId: true, credit: tax });
  await postJournal(ctx, {
    branchId: e.branch_id,
    date,
    sourceType: "expense_refund",
    sourceId: refundId,
    description: `${number} · Actual refund received for ${e.number}`,
    lines,
  });
  await audit(
    ctx,
    "refund_received",
    "expense",
    e.id,
    null,
    { refund_id: refundId, number, amount, net, tax, payment_id: payment.id },
    input.reason,
  );
  return {
    id: refundId,
    number,
    amount,
    net,
    tax,
    remaining: money(D(e.total).minus(used.amount).minus(amount)),
  };
}
export async function reverseExpenseRefund(
  ctx: Context,
  id: string,
  input: {
    payment: Payment;
    shift_id?: string;
    reason: string;
    accounting_date?: string;
  },
) {
  requirePermission(ctx, "expenses.pay");
  requirePermission(ctx, "expenses.approve");
  requirePermission(ctx, "accounting.reverse");
  const date = await accountingDate(ctx, input.accounting_date),
    hint = await one(
      ctx,
      "SELECT expense_id,branch_id FROM expense_refunds WHERE company_id=$1 AND id=$2",
      [ctx.companyId, id],
    );
  branchAccess(ctx, hint.branch_id);
  const e = await lockExpense(ctx, hint.expense_id, input.shift_id),
    original = await one(
      ctx,
      "SELECT * FROM expense_refunds WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, id],
    );
  if (
    original.kind !== "refund" ||
    (
      await ctx.db.query(
        "SELECT id FROM expense_refunds WHERE company_id=$1 AND reversal_of=$2",
        [ctx.companyId, id],
      )
    ).rowCount
  )
    fail(
      409,
      "ALREADY_REVERSED",
      "This record is a repayment reversal or the refund was already reversed",
    );
  const posting = await originalPosting(ctx, e);
  await dateOrder(ctx, e, posting.journal.date, date);
  await checkApproval(ctx, original.created_by, original.amount, input.reason);
  const reversalId = randomUUID(),
    number = await nextNumber(ctx, "ERF"),
    payment = await recordPayment(
      ctx,
      { ...input.payment, amount: original.amount },
      {
        branchId: e.branch_id,
        shiftId: input.shift_id,
        sourceType: "expense_refund",
        sourceId: reversalId,
        direction: "out",
        date,
      },
    );
  await insert(ctx, {
    ...original,
    id: reversalId,
    number,
    kind: "reversal",
    reversal_of: original.id,
    payment_id: payment.id,
    accounting_date: date,
    reason: input.reason,
  });
  const oldJournal = await one(
    ctx,
    "SELECT id FROM journals WHERE company_id=$1 AND source_type='expense_refund' AND source_id=$2",
    [ctx.companyId, id],
  );
  const lines: PostingLine[] = [
    {
      account: original.expense_account_id,
      byId: true,
      debit: original.net,
      memo: `Reinstate expense after actual refund repayment`,
    },
    { account: payment.account, byId: true, credit: original.amount },
  ];
  if (D(original.tax).gt(0))
    lines.push({
      account: original.tax_account_id,
      byId: true,
      debit: original.tax,
    });
  await postJournal(ctx, {
    branchId: e.branch_id,
    date,
    sourceType: "expense_refund",
    sourceId: reversalId,
    reversalOf: oldJournal.id,
    description: `${number} · Actual repayment reverses ${original.number}`,
    lines,
  });
  await audit(
    ctx,
    "refund_repaid",
    "expense",
    e.id,
    original,
    { reversal_id: reversalId, number, payment_id: payment.id },
    input.reason,
  );
  const used = await totals(ctx, e.id);
  return {
    id: reversalId,
    number,
    amount: original.amount,
    remaining: money(D(e.total).minus(used.amount)),
  };
}
export async function getExpense(ctx: Context, id: string) {
  requirePermission(ctx, "expenses.read");
  const e = await one(
    ctx,
    "SELECT e.*,c.name AS category,u.name AS created_by_name,j.accounting_date::text AS posting_date FROM expenses e JOIN expense_categories c ON c.company_id=e.company_id AND c.id=e.category_id JOIN identities u ON u.company_id=e.company_id AND u.id=e.created_by LEFT JOIN journals j ON j.company_id=e.company_id AND j.source_type='expense' AND j.source_id=e.id WHERE e.company_id=$1 AND e.id=$2",
    [ctx.companyId, id],
  );
  branchAccess(ctx, e.branch_id);
  const used = await totals(ctx, id),
    history = (
      await ctx.db.query(
        "SELECT r.*,p.method_id,p.reference,m.name AS method,v.id AS reversed_by FROM expense_refunds r JOIN payments p ON p.company_id=r.company_id AND p.id=r.payment_id JOIN payment_methods m ON m.company_id=p.company_id AND m.id=p.method_id LEFT JOIN expense_refunds v ON v.company_id=r.company_id AND v.reversal_of=r.id WHERE r.company_id=$1 AND r.expense_id=$2 ORDER BY r.created_at,r.number",
        [ctx.companyId, id],
      )
    ).rows;
  return {
    ...e,
    refunded: used.amount,
    remaining: money(D(e.total).minus(used.amount)),
    refunds: history,
  };
}
