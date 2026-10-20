import { D, money } from "@duka/shared";
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
import { postJournal, type PostingLine } from "@duka/accounting";
import {
  invoiceOutstanding,
  recordPayment,
  validateShift,
} from "./payments.ts";
type Payment = { method_id: string; reference?: string; intent_id?: string };
type Input = {
  invoice_id: string;
  kind: "offset" | "refund";
  amount: string;
  target_invoice_id?: string;
  payment?: Payment;
  shift_id?: string;
  reason: string;
  accounting_date?: string;
};
async function lockScope(ctx: Context, invoiceId: string, shiftId?: string) {
  const hint = await one(
    ctx,
    "SELECT supplier_id,branch_id FROM supplier_invoices WHERE company_id=$1 AND id=$2",
    [ctx.companyId, invoiceId],
  );
  branchAccess(ctx, hint.branch_id);
  if (shiftId) await validateShift(ctx, shiftId, hint.branch_id);
  await one(
    ctx,
    "SELECT id FROM suppliers WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, hint.supplier_id],
  );
  return invoiceOutstanding(ctx, invoiceId);
}
async function checkDate(ctx: Context, date: string, ids: string[]) {
  const row = await one(
    ctx,
    `SELECT max(d)::text AS latest FROM (
 SELECT accounting_date AS d FROM supplier_invoices WHERE company_id=$1 AND id=ANY($2::uuid[])
 UNION ALL SELECT accounting_date FROM supplier_allocations WHERE company_id=$1 AND invoice_id=ANY($2::uuid[])
 UNION ALL SELECT accounting_date FROM supplier_returns WHERE company_id=$1 AND invoice_id=ANY($2::uuid[])
 UNION ALL SELECT accounting_date FROM supplier_credit_settlements WHERE company_id=$1 AND (from_invoice_id=ANY($2::uuid[]) OR to_invoice_id=ANY($2::uuid[]))) e`,
    [ctx.companyId, ids],
  );
  if (row.latest && date < row.latest)
    fail(
      409,
      "CREDIT_DATE_ORDER",
      "Credit settlement/reversal cannot precede related invoice, payment, return or credit activity",
    );
}
async function insert(ctx: Context, data: any) {
  await ctx.db.query(
    "INSERT INTO supplier_credit_settlements(id,company_id,branch_id,supplier_id,from_invoice_id,to_invoice_id,kind,number,amount,payment_id,reversal_of,accounting_date,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
    [
      data.id,
      ctx.companyId,
      data.branch_id,
      data.supplier_id,
      data.from_invoice_id,
      data.to_invoice_id ?? null,
      data.kind,
      data.number,
      data.amount,
      data.payment_id ?? null,
      data.reversal_of ?? null,
      data.accounting_date,
      data.reason,
      ctx.actor.id,
    ],
  );
}
async function balance(ctx: Context, id: string) {
  return (
    await one(ctx, "SELECT supplier_invoice_balance($1,$2)::text AS amount", [
      ctx.companyId,
      id,
    ])
  ).amount;
}
export async function settleSupplierCredit(ctx: Context, input: Input) {
  requirePermission(ctx, "payments.pay");
  const date = await accountingDate(ctx, input.accounting_date);
  const source = await lockScope(ctx, input.invoice_id, input.shift_id),
    amount = money(input.amount);
  if (!D(input.amount).eq(amount) || !D(amount).gt(0))
    fail(422, "CREDIT_AMOUNT", "Use a positive amount at currency precision");
  if (D(amount).gt(D(source.outstanding).neg()))
    fail(
      409,
      "SUPPLIER_CREDIT_INSUFFICIENT",
      "Amount exceeds this invoice’s available supplier credit",
    );
  const target =
    input.kind === "offset" && input.target_invoice_id
      ? await invoiceOutstanding(ctx, input.target_invoice_id)
      : null;
  if (input.kind === "offset") {
    if (
      !target ||
      target.id === source.id ||
      target.supplier_id !== source.supplier_id ||
      target.branch_id !== source.branch_id
    )
      fail(
        422,
        "CREDIT_TARGET_MISMATCH",
        "Apply a credit to a different invoice of the same supplier and branch",
      );
    if (input.payment)
      fail(
        422,
        "CREDIT_PAYMENT_UNEXPECTED",
        "An invoice offset does not move cash",
      );
    if (D(amount).gt(target.outstanding))
      fail(
        409,
        "OVER_ALLOCATION",
        "Credit exceeds the target invoice’s outstanding amount",
      );
  } else if (!input.payment || input.target_invoice_id)
    fail(
      422,
      "CREDIT_REFUND_PAYMENT",
      "A refund needs its actual incoming payment, not a target invoice",
    );
  await checkDate(ctx, date, [source.id, ...(target ? [target.id] : [])]);
  const id = randomUUID(),
    number = await nextNumber(ctx, "SCS");
  const pay =
    input.kind === "refund"
      ? await recordPayment(
          ctx,
          { ...input.payment!, amount },
          {
            branchId: source.branch_id,
            shiftId: input.shift_id,
            sourceType: "supplier_credit_settlement",
            sourceId: id,
            direction: "in",
            date,
          },
        )
      : null;
  await insert(ctx, {
    id,
    number,
    branch_id: source.branch_id,
    supplier_id: source.supplier_id,
    from_invoice_id: source.id,
    to_invoice_id: target?.id,
    kind: input.kind,
    amount,
    payment_id: pay?.id,
    accounting_date: date,
    reason: input.reason,
  });
  const lines: PostingLine[] = target
    ? [
        {
          account: "ap",
          debit: amount,
          supplierId: source.supplier_id,
          memo: `Apply credit to ${target.number}`,
        },
        {
          account: "ap",
          credit: amount,
          supplierId: source.supplier_id,
          memo: `Use credit from ${source.number}`,
        },
      ]
    : [
        {
          account: pay!.account,
          byId: true,
          debit: amount,
          memo: "Actual refund received from supplier",
        },
        { account: "ap", credit: amount, supplierId: source.supplier_id },
      ];
  await postJournal(ctx, {
    branchId: source.branch_id,
    date,
    sourceType: "supplier_credit_settlement",
    sourceId: id,
    description: `${number} · ${input.kind === "offset" ? "Supplier invoice credit allocation" : "Supplier credit refund received"}`,
    lines,
  });
  await audit(
    ctx,
    "post",
    "supplier_credit_settlement",
    id,
    null,
    { number, ...input },
    input.reason,
  );
  return {
    id,
    number,
    kind: input.kind,
    amount,
    source_outstanding: await balance(ctx, source.id),
    ...(target ? { target_outstanding: await balance(ctx, target.id) } : {}),
  };
}
export async function reverseSupplierCredit(
  ctx: Context,
  id: string,
  input: {
    reason: string;
    payment?: Payment;
    shift_id?: string;
    accounting_date?: string;
  },
) {
  requirePermission(ctx, "payments.pay");
  requirePermission(ctx, "accounting.reverse");
  const date = await accountingDate(ctx, input.accounting_date);
  const hint = await one(
    ctx,
    "SELECT * FROM supplier_credit_settlements WHERE company_id=$1 AND id=$2",
    [ctx.companyId, id],
  );
  branchAccess(ctx, hint.branch_id);
  const source = await lockScope(ctx, hint.from_invoice_id, input.shift_id);
  if (hint.to_invoice_id) await invoiceOutstanding(ctx, hint.to_invoice_id);
  const original = await one(
    ctx,
    "SELECT * FROM supplier_credit_settlements WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  if (
    original.kind === "reversal" ||
    (
      await ctx.db.query(
        "SELECT id FROM supplier_credit_settlements WHERE company_id=$1 AND reversal_of=$2",
        [ctx.companyId, id],
      )
    ).rowCount
  )
    fail(
      409,
      "ALREADY_REVERSED",
      "This credit settlement is a reversal or was already reversed",
    );
  if (original.kind === "refund" && !input.payment)
    fail(
      422,
      "CREDIT_REFUND_PAYMENT",
      "Reversing a received refund needs the actual outgoing repayment",
    );
  if (original.kind === "offset" && input.payment)
    fail(
      422,
      "CREDIT_PAYMENT_UNEXPECTED",
      "Reversing an invoice offset does not move cash",
    );
  await checkDate(ctx, date, [
    source.id,
    ...(original.to_invoice_id ? [original.to_invoice_id] : []),
  ]);
  const reversalId = randomUUID(),
    number = await nextNumber(ctx, "SCS"),
    amount = original.amount;
  const pay =
    original.kind === "refund"
      ? await recordPayment(
          ctx,
          { ...input.payment!, amount },
          {
            branchId: source.branch_id,
            shiftId: input.shift_id,
            sourceType: "supplier_credit_settlement",
            sourceId: reversalId,
            direction: "out",
            date,
          },
        )
      : null;
  await insert(ctx, {
    ...original,
    id: reversalId,
    number,
    kind: "reversal",
    payment_id: pay?.id,
    reversal_of: original.id,
    accounting_date: date,
    reason: input.reason,
  });
  const journal = await one(
    ctx,
    "SELECT id FROM journals WHERE company_id=$1 AND source_type='supplier_credit_settlement' AND source_id=$2",
    [ctx.companyId, original.id],
  );
  const lines: PostingLine[] =
    original.kind === "offset"
      ? [
          {
            account: "ap",
            debit: amount,
            supplierId: source.supplier_id,
            memo: `Restore credit from ${original.number}`,
          },
          {
            account: "ap",
            credit: amount,
            supplierId: source.supplier_id,
            memo: "Restore target invoice liability",
          },
        ]
      : [
          { account: "ap", debit: amount, supplierId: source.supplier_id },
          {
            account: pay!.account,
            byId: true,
            credit: amount,
            memo: "Actual supplier-refund repayment",
          },
        ];
  await postJournal(ctx, {
    branchId: source.branch_id,
    date,
    sourceType: "supplier_credit_settlement",
    sourceId: reversalId,
    reversalOf: journal.id,
    description: `${number} · Reverse ${original.number}: ${input.reason}`,
    lines,
  });
  await audit(
    ctx,
    "reverse",
    "supplier_credit_settlement",
    original.id,
    original,
    { reversal_id: reversalId, number },
    input.reason,
  );
  return {
    id: reversalId,
    number,
    amount,
    source_outstanding: await balance(ctx, source.id),
  };
}
