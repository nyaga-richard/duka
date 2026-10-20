import {
  openingDebtOutstanding,
  insertOpeningAllocation,
} from "./opening-balances.ts";
import { D, money, sum } from "@duka/shared";
import { randomUUID } from "node:crypto";
import {
  one,
  fail,
  branchAccess,
  requirePermission,
  has,
  audit,
  nextNumber,
  accountingDate,
  uniqueIds,
  type Context,
} from "../db.ts";
import { postJournal, type PostingLine } from "@duka/accounting";
import { createAdvance, consumeAdvance } from "./advances.ts";
export async function validateShift(
  ctx: Context,
  id: string,
  branchId: string,
  ownerOnly = false,
) {
  const s = await one(
    ctx,
    "SELECT * FROM shifts WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, s.branch_id);
  if (s.branch_id !== branchId)
    fail(422, "SHIFT_BRANCH", "Shift does not belong to this branch");
  if (!["open", "rejected"].includes(s.status))
    fail(409, "SHIFT_CLOSED", "The cashier shift is not open");
  if (
    s.cashier_id !== ctx.actor.id &&
    (ownerOnly || !has(ctx, "shifts.manage"))
  )
    fail(403, "SHIFT_OWNER", "This shift belongs to another cashier");
  return s;
}
export async function recordPayment(
  ctx: Context,
  input: {
    method_id: string;
    amount: string;
    reference?: string;
    intent_id?: string;
  },
  meta: {
    branchId: string;
    shiftId?: string;
    sourceType: string;
    sourceId: string;
    direction: "in" | "out";
    date: string;
  },
) {
  branchAccess(ctx, meta.branchId);
  const method = await one(
    ctx,
    "SELECT * FROM payment_methods WHERE company_id=$1 AND id=$2 AND active",
    [ctx.companyId, input.method_id],
  );
  if (!D(input.amount).gt(0))
    fail(422, "PAYMENT_AMOUNT", "Payment must be greater than zero");
  if (method.requires_reference && !input.reference && !input.intent_id)
    fail(422, "PAYMENT_REFERENCE", "A payment reference is required");
  const shift = meta.shiftId
    ? await validateShift(ctx, meta.shiftId, meta.branchId)
    : undefined;
  if (method.kind === "cash" && !meta.shiftId)
    fail(422, "CASH_SHIFT_REQUIRED", "Cash movements require an open shift");
  if (method.kind === "cash" && meta.direction === "out") {
    const cash = await one(
      ctx,
      `SELECT $3::numeric+coalesce((SELECT sum(CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END) FROM payments p JOIN payment_methods m ON m.company_id=p.company_id AND m.id=p.method_id WHERE p.company_id=$1 AND p.shift_id=$2 AND m.kind='cash' AND NOT EXISTS(SELECT 1 FROM expense_voids v WHERE v.company_id=p.company_id AND v.payment_id=p.id)),0)+coalesce((SELECT sum(CASE WHEN direction='in' THEN amount ELSE -amount END) FROM cash_movements WHERE company_id=$1 AND shift_id=$2),0) AS available`,
      [ctx.companyId, meta.shiftId, shift!.opening_float],
    );
    if (D(input.amount).gt(cash.available))
      fail(
        409,
        "CASH_INSUFFICIENT",
        "Cash payout exceeds expected physical cash in this locked shift",
      );
  }
  let reference = input.reference ?? null;
  if (method.kind === "mpesa") {
    if (meta.direction === "out")
      fail(
        409,
        "PROVIDER_REFUND_PENDING",
        "M-Pesa refunds must be requested and confirmed separately; use a pending refund request",
      );
    if (input.intent_id) {
      const intent = await one(
        ctx,
        "SELECT * FROM payment_intents WHERE company_id=$1 AND id=$2 FOR UPDATE",
        [ctx.companyId, input.intent_id],
      );
      if (
        intent.branch_id !== meta.branchId ||
        intent.status !== "successful" ||
        intent.consumed_by ||
        !D(intent.amount).eq(input.amount)
      )
        fail(
          409,
          "PAYMENT_UNCONFIRMED",
          "M-Pesa payment is unconfirmed, already allocated, or the amount differs",
        );
      reference = intent.receipt_number;
      await ctx.db.query(
        "UPDATE payment_intents SET consumed_by=$1,updated_at=now() WHERE company_id=$2 AND id=$3",
        [meta.sourceId, ctx.companyId, intent.id],
      );
    } else {
      requirePermission(ctx, "integrations.manage");
      if (!reference)
        fail(
          422,
          "PAYMENT_REFERENCE",
          "Verified receipt number required for manual M-Pesa reconciliation",
        );
      await audit(
        ctx,
        "manual_confirmation",
        "payment",
        meta.sourceId,
        null,
        { method: method.name, reference, amount: input.amount },
        "Manager-attested external statement reconciliation",
      );
    }
  } else if (input.intent_id)
    fail(
      422,
      "PAYMENT_METHOD_MISMATCH",
      "A mobile-money intent can only be used with M-Pesa",
    );
  const id = randomUUID();
  await ctx.db.query(
    "INSERT INTO payments(id,company_id,branch_id,method_id,shift_id,amount,direction,source_type,source_id,reference,created_by,accounting_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [
      id,
      ctx.companyId,
      meta.branchId,
      method.id,
      meta.shiftId ?? null,
      input.amount,
      meta.direction,
      meta.sourceType,
      meta.sourceId,
      reference,
      ctx.actor.id,
      meta.date,
    ],
  );
  return {
    id,
    account: method.account_id,
    method,
    amount: money(input.amount),
    reference,
  };
}
export async function saleOutstanding(ctx: Context, id: string) {
  const locked = await one(
    ctx,
    "SELECT id,branch_id FROM sales WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, locked.branch_id);
  // Child sums need a NEW READ COMMITTED statement after the parent lock wait.
  // A lock and subselect in one SELECT can retain a pre-wait child snapshot.
  const s = await one(
    ctx,
    `SELECT s.*,s.accounting_date::text AS document_date,coalesce((SELECT sum(a.amount) FROM customer_allocations a WHERE a.company_id=s.company_id AND a.sale_id=s.id),0)::text AS allocated,coalesce((SELECT sum(r.credit_applied) FROM sale_returns r WHERE r.company_id=s.company_id AND r.sale_id=s.id),0)::text AS credited FROM sales s WHERE s.company_id=$1 AND s.id=$2`,
    [ctx.companyId, id],
  );
  branchAccess(ctx, s.branch_id);
  return {
    ...s,
    outstanding: money(
      D(s.total).minus(s.paid_at_sale).minus(s.allocated).minus(s.credited),
    ),
  };
}
export async function invoiceOutstanding(ctx: Context, id: string) {
  const locked = await one(
    ctx,
    "SELECT id,branch_id FROM supplier_invoices WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, locked.branch_id);
  const s = await one(
    ctx,
    `SELECT s.*,s.accounting_date::text AS document_date,coalesce((SELECT sum(a.amount) FROM supplier_allocations a WHERE a.company_id=s.company_id AND a.invoice_id=s.id),0)::text AS allocated,coalesce((SELECT sum(r.total) FROM supplier_returns r WHERE r.company_id=s.company_id AND r.invoice_id=s.id),0)::text AS credited,supplier_invoice_balance(s.company_id,s.id)::text AS outstanding FROM supplier_invoices s WHERE s.company_id=$1 AND s.id=$2`,
    [ctx.companyId, id],
  );
  branchAccess(ctx, s.branch_id);
  return {
    ...s,
    outstanding: money(s.outstanding),
  };
}
export async function settleContact(
  ctx: Context,
  kind: "customer" | "supplier",
  input: any,
) {
  requirePermission(
    ctx,
    kind === "customer" ? "payments.receive" : "payments.pay",
  );
  branchAccess(ctx, input.branch_id);
  const date = await accountingDate(ctx, input.accounting_date);
  if (input.shift_id) await validateShift(ctx, input.shift_id, input.branch_id);
  const customer = kind === "customer",
    table = customer ? "customers" : "suppliers";
  await one(
    ctx,
    `SELECT id FROM ${table} WHERE company_id=$1 AND id=$2 AND active FOR UPDATE`,
    [ctx.companyId, input.contact_id],
  );
  uniqueIds(input.allocations.map((a: any) => a.document_id));
  const allocated = sum(input.allocations.map((a: any) => a.amount));
  if (allocated.gt(input.payment.amount))
    fail(422, "ALLOCATION_EXCEEDS_PAYMENT", "Allocated amount exceeds payment");
  for (const a of [...input.allocations].sort((a: any, b: any) =>
    a.document_id.localeCompare(b.document_id),
  )) {
    const doc =
      a.document_type === "opening"
        ? await openingDebtOutstanding(ctx, a.document_id)
        : customer
          ? await saleOutstanding(ctx, a.document_id)
          : await invoiceOutstanding(ctx, a.document_id);
    if (
      (a.document_type === "opening" && doc.kind !== kind) ||
      (a.document_type === "opening"
        ? date <= doc.document_date
        : date < doc.document_date)
    )
      fail(
        409,
        "ALLOCATION_DATE_KIND",
        "Payment must be after the opening cutover (or on/after the invoice) and match the debt type",
      );
    if (doc[customer ? "customer_id" : "supplier_id"] !== input.contact_id)
      fail(422, "CONTACT_MISMATCH", "Document belongs to a different contact");
    if (doc.branch_id !== input.branch_id)
      fail(
        422,
        "BRANCH_MISMATCH",
        "Allocate payments within the selected branch",
      );
    if (D(a.amount).gt(doc.outstanding))
      fail(
        409,
        "OVER_ALLOCATION",
        "Allocation exceeds the outstanding document balance",
      );
  }
  const id = randomUUID(),
    number = await nextNumber(ctx, customer ? "RCT" : "SPY"),
    unapplied = money(D(input.payment.amount).minus(allocated));
  await ctx.db.query(
    `INSERT INTO ${customer ? "customer_receipts" : "supplier_payments"}(id,company_id,branch_id,${customer ? "customer_id" : "supplier_id"},number,amount,unapplied,created_by,accounting_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      ctx.companyId,
      input.branch_id,
      input.contact_id,
      number,
      input.payment.amount,
      unapplied,
      ctx.actor.id,
      date,
    ],
  );
  for (const a of input.allocations) {
    if (a.document_type === "opening")
      await insertOpeningAllocation(ctx, {
        itemId: a.document_id,
        amount: a.amount,
        date,
        ...(customer ? { receiptId: id } : { paymentId: id }),
      });
    else
      await ctx.db.query(
        `INSERT INTO ${customer ? "customer_allocations" : "supplier_allocations"}(company_id,${customer ? "receipt_id" : "payment_id"},${customer ? "sale_id" : "invoice_id"},amount) VALUES($1,$2,$3,$4)`,
        [ctx.companyId, id, a.document_id, a.amount],
      );
  }
  await createAdvance(ctx, {
    kind,
    contactId: input.contact_id,
    branchId: input.branch_id,
    sourceType: customer ? "customer_receipt" : "supplier_payment",
    sourceId: id,
    amount: unapplied,
    date,
  });
  const pay = await recordPayment(ctx, input.payment, {
    branchId: input.branch_id,
    shiftId: input.shift_id,
    sourceType: customer ? "customer_receipt" : "supplier_payment",
    sourceId: id,
    direction: customer ? "in" : "out",
    date,
  });
  const contact = customer
    ? { customerId: input.contact_id }
    : { supplierId: input.contact_id };
  const lines: PostingLine[] = customer
    ? [{ account: pay.account, byId: true, debit: input.payment.amount }]
    : [{ account: pay.account, byId: true, credit: input.payment.amount }];
  if (allocated.gt(0))
    lines.push({
      account: customer ? "ar" : "ap",
      ...contact,
      ...(customer
        ? { credit: money(allocated) }
        : { debit: money(allocated) }),
    });
  if (D(unapplied).gt(0))
    lines.push({
      account: customer ? "customer_advances" : "supplier_advances",
      ...contact,
      ...(customer ? { credit: unapplied } : { debit: unapplied }),
    });
  await postJournal(ctx, {
    branchId: input.branch_id,
    date,
    sourceType: customer ? "customer_receipt" : "supplier_payment",
    sourceId: id,
    description: `${number} · ${customer ? "Customer receipt" : "Supplier payment"}`,
    lines,
  });
  await audit(
    ctx,
    "post",
    customer ? "customer_receipt" : "supplier_payment",
    id,
    null,
    { number, amount: input.payment.amount, unapplied },
  );
  return {
    id,
    number,
    amount: input.payment.amount,
    allocated: money(allocated),
    unapplied,
  };
}
export async function applyAdvance(
  ctx: Context,
  kind: "customer" | "supplier",
  input: {
    source_id: string;
    document_id: string;
    document_type?: "invoice" | "opening";
    amount: string;
    accounting_date?: string;
  },
) {
  const customer = kind === "customer";
  requirePermission(ctx, customer ? "payments.receive" : "payments.pay");
  const date = await accountingDate(ctx, input.accounting_date);
  const hint = await one(
    ctx,
    `SELECT branch_id,${customer ? "customer_id" : "supplier_id"} AS contact_id FROM ${customer ? "customer_receipts" : "supplier_payments"} WHERE company_id=$1 AND id=$2`,
    [ctx.companyId, input.source_id],
  );
  branchAccess(ctx, hint.branch_id);
  await one(
    ctx,
    `SELECT id FROM ${customer ? "customers" : "suppliers"} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
    [ctx.companyId, hint.contact_id],
  );
  const src = await one(
    ctx,
    `SELECT * FROM ${customer ? "customer_receipts" : "supplier_payments"} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
    [ctx.companyId, input.source_id],
  );
  branchAccess(ctx, src.branch_id);
  const used = (
    await ctx.db.query(
      `SELECT (coalesce((SELECT sum(amount) FROM ${customer ? "customer_allocations" : "supplier_allocations"} WHERE company_id=$1 AND ${customer ? "receipt_id" : "payment_id"}=$2),0)+coalesce((SELECT sum(amount) FROM opening_allocations WHERE company_id=$1 AND ${customer ? "receipt_id" : "payment_id"}=$2),0))::text AS n`,
      [ctx.companyId, src.id],
    )
  ).rows[0].n;
  const remaining = D(src.amount).minus(used);
  if (D(input.amount).gt(remaining))
    fail(409, "ADVANCE_INSUFFICIENT", "Insufficient unapplied advance");
  const doc =
    input.document_type === "opening"
      ? await openingDebtOutstanding(ctx, input.document_id)
      : customer
        ? await saleOutstanding(ctx, input.document_id)
        : await invoiceOutstanding(ctx, input.document_id);
  if (
    (input.document_type === "opening" && doc.kind !== kind) ||
    (input.document_type === "opening"
      ? date <= doc.document_date
      : date < doc.document_date)
  )
    fail(
      409,
      "ALLOCATION_DATE_KIND",
      "Allocation must match debt type and not precede its opening/invoice date",
    );
  if (
    doc[customer ? "customer_id" : "supplier_id"] !==
      src[customer ? "customer_id" : "supplier_id"] ||
    doc.branch_id !== src.branch_id
  )
    fail(
      422,
      "CONTACT_MISMATCH",
      "Advance and invoice must have the same contact and branch",
    );
  if (D(input.amount).gt(doc.outstanding))
    fail(409, "OVER_ALLOCATION", "Amount exceeds outstanding invoice");
  const id = randomUUID();
  await consumeAdvance(ctx, {
    kind,
    contactId: src[customer ? "customer_id" : "supplier_id"],
    branchId: src.branch_id,
    targetType: "advance_allocation",
    targetId: id,
    amount: input.amount,
    date,
    sourceId: src.id,
  });
  if (input.document_type === "opening")
    await insertOpeningAllocation(ctx, {
      id,
      itemId: doc.id,
      amount: input.amount,
      date,
      ...(customer ? { receiptId: src.id } : { paymentId: src.id }),
    });
  else
    await ctx.db.query(
      `INSERT INTO ${customer ? "customer_allocations" : "supplier_allocations"}(company_id,${customer ? "receipt_id" : "payment_id"},${customer ? "sale_id" : "invoice_id"},amount) VALUES($1,$2,$3,$4)`,
      [ctx.companyId, src.id, doc.id, input.amount],
    );
  const contact = customer
    ? { customerId: src.customer_id }
    : { supplierId: src.supplier_id };
  await postJournal(ctx, {
    branchId: src.branch_id,
    date,
    sourceType: "advance_allocation",
    sourceId: id,
    description: "Apply unapplied advance",
    lines: customer
      ? [
          { account: "customer_advances", debit: input.amount, ...contact },
          { account: "ar", credit: input.amount, ...contact },
        ]
      : [
          { account: "ap", debit: input.amount, ...contact },
          { account: "supplier_advances", credit: input.amount, ...contact },
        ],
  });
  await audit(ctx, "allocate", "advance", src.id, null, input);
  return { id, amount: input.amount };
}
