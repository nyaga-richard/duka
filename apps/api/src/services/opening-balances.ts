import { D, money, sum } from "@duka/shared";
import { randomUUID } from "node:crypto";
import {
  one,
  fail,
  requirePermission,
  branchAccess,
  accountingDate,
  nextNumber,
  audit,
  pageArgs,
  type Context,
} from "../db.ts";
import { postJournal, type PostingLine } from "@duka/accounting";
import { checkApproval } from "./shifts.ts";
import { consumeAdvance } from "./advances.ts";
export const debtJournalSources = [
  "sale",
  "sale_return",
  "customer_receipt",
  "supplier_invoice",
  "supplier_payment",
  "supplier_return",
  "supplier_credit_settlement",
  "advance_allocation",
  "opening_allocation",
];
type ItemInput = {
  kind: "customer" | "supplier";
  direction?: "debt" | "credit";
  contact_id?: string;
  contact_code?: string;
  reference: string;
  original_date?: string;
  due_date: string;
  amount: string;
  description?: string;
};
export type OpeningInput = {
  branch_id: string;
  accounting_date: string;
  reference: string;
  notes?: string;
  items: ItemInput[];
};
async function lockParties(ctx: Context, items: any[]) {
  const seen = new Set<string>();
  for (const i of [...items].sort((a, b) =>
    (a.kind + ":" + (a.customer_id ?? a.supplier_id)).localeCompare(
      b.kind + ":" + (b.customer_id ?? b.supplier_id),
    ),
  )) {
    const id = i.customer_id ?? i.supplier_id,
      key = i.kind + ":" + id;
    if (seen.has(key)) continue;
    seen.add(key);
    await one(
      ctx,
      `SELECT id FROM ${i.kind === "customer" ? "customers" : "suppliers"} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
      [ctx.companyId, id],
    );
  }
}
export async function openingMetadata(ctx: Context, branchId: string) {
  requirePermission(ctx, "accounting.read");
  branchAccess(ctx, branchId);
  const data = await one(
    ctx,
    "SELECT (SELECT accounting_date::text FROM opening_cutovers WHERE company_id=$1 AND branch_id=$2) AS cutover,(SELECT min(accounting_date)::text FROM journals WHERE company_id=$1 AND branch_id=$2 AND source_type=ANY($3::text[])) AS first_activity,to_char(now() AT TIME ZONE timezone,'YYYY-MM-DD') AS today FROM companies WHERE id=$1",
    [ctx.companyId, branchId, debtJournalSources],
  );
  const suggested = await one(
    ctx,
    "SELECT (coalesce($1::date,$2::date)-1)::text AS date",
    [data.first_activity, data.today],
  );
  return {
    ...data,
    suggested_cutover: data.cutover ?? suggested.date,
    policy:
      "Positive outstanding legacy AR/AP and legacy party advances/credits only; no sales, purchases, VAT, stock or cash is generated. Credits become real advance balances offset against opening equity.",
  };
}
async function writeItems(ctx: Context, batchId: string, items: ItemInput[]) {
  if (!items.length || items.length > 500)
    fail(422, "OPENING_ITEMS", "Supply 1–500 positive legacy debt items");
  for (const i of items) {
    const direction = i.direction ?? "debt";
    if (!D(i.amount).gt(0) || !D(i.amount).eq(money(i.amount)))
      fail(
        422,
        "OPENING_AMOUNT",
        "Use positive amounts at currency precision; direction, not sign, separates debt from credits",
      );
    if (!!i.contact_id === !!i.contact_code)
      fail(
        422,
        "OPENING_CONTACT",
        "Supply either a contact ID or its account code, not both",
      );
    const p = await one(
      ctx,
      `SELECT id FROM ${i.kind === "customer" ? "customers" : "suppliers"} WHERE company_id=$1 AND active AND ${i.contact_id ? "id=$2::uuid" : "code=$2"}`,
      [ctx.companyId, i.contact_id ?? i.contact_code],
    );
    await ctx.db.query(
      "INSERT INTO opening_items(id,company_id,batch_id,kind,direction,customer_id,supplier_id,reference,original_date,due_date,amount,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        randomUUID(),
        ctx.companyId,
        batchId,
        i.kind,
        direction,
        i.kind === "customer" ? p.id : null,
        i.kind === "supplier" ? p.id : null,
        i.reference.trim(),
        i.original_date ?? null,
        i.due_date,
        money(i.amount),
        i.description ?? "",
      ],
    );
  }
}
export async function saveOpeningBatch(
  ctx: Context,
  input: OpeningInput,
  id?: string,
) {
  requirePermission(ctx, "accounting.post");
  branchAccess(ctx, input.branch_id);
  await accountingDate(ctx, input.accounting_date);
  if (id) {
    const old = await one(
      ctx,
      "SELECT * FROM opening_batches WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, id],
    );
    branchAccess(ctx, old.branch_id);
    if (old.status !== "draft")
      fail(
        409,
        "OPENING_DRAFT_ONLY",
        "Return a submitted batch to draft before editing; posted balances are immutable",
      );
    await ctx.db.query(
      "DELETE FROM opening_items WHERE company_id=$1 AND batch_id=$2",
      [ctx.companyId, id],
    );
    await ctx.db.query(
      "UPDATE opening_batches SET branch_id=$1,accounting_date=$2,reference=$3,notes=$4 WHERE company_id=$5 AND id=$6",
      [
        input.branch_id,
        input.accounting_date,
        input.reference,
        input.notes ?? "",
        ctx.companyId,
        id,
      ],
    );
    await writeItems(ctx, id, input.items);
    await audit(ctx, "edit_draft", "opening_batch", id, old, {
      ...input,
      items: input.items.length,
    });
  } else {
    id = randomUUID();
    const number = await nextNumber(ctx, "OB");
    await ctx.db.query(
      "INSERT INTO opening_batches(id,company_id,branch_id,number,accounting_date,reference,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        ctx.companyId,
        input.branch_id,
        number,
        input.accounting_date,
        input.reference,
        input.notes ?? "",
        ctx.actor.id,
      ],
    );
    await writeItems(ctx, id, input.items);
    await audit(ctx, "create_draft", "opening_batch", id, null, {
      number,
      reference: input.reference,
      items: input.items.length,
    });
  }
  return getOpeningBatch(ctx, id);
}
export async function getOpeningBatch(ctx: Context, id: string) {
  requirePermission(ctx, "accounting.read");
  const b = await one(
    ctx,
    "SELECT b.*,b.accounting_date::text AS accounting_date,u.name AS created_by_name,r.id AS reversal_id,r.accounting_date::text AS reversed_on,r.number AS reversal_number FROM opening_batches b JOIN identities u ON u.company_id=b.company_id AND u.id=b.created_by LEFT JOIN opening_batch_reversals r ON r.company_id=b.company_id AND r.batch_id=b.id WHERE b.company_id=$1 AND b.id=$2",
    [ctx.companyId, id],
  );
  branchAccess(ctx, b.branch_id);
  const items = (
    await ctx.db.query(
      "SELECT i.*,i.original_date::text AS original_date,i.due_date::text AS due_date,coalesce(c.name,s.name) AS contact,coalesce(c.code,s.code) AS contact_code,opening_item_balance(i.company_id,i.id)::text AS outstanding,(SELECT (v.amount-coalesce((SELECT sum(u.amount) FROM advance_uses u WHERE u.company_id=v.company_id AND u.credit_id=v.id),0))::text FROM advance_credits v WHERE v.company_id=i.company_id AND v.source_type='opening_balance' AND v.source_id=i.id) AS credit_available FROM opening_items i LEFT JOIN customers c ON c.company_id=i.company_id AND c.id=i.customer_id LEFT JOIN suppliers s ON s.company_id=i.company_id AND s.id=i.supplier_id WHERE i.company_id=$1 AND i.batch_id=$2 ORDER BY i.kind,i.direction,contact,i.reference,i.id",
      [ctx.companyId, id],
    )
  ).rows;
  const debt = items.filter((i) => i.direction === "debt"),
    credits = items.filter((i) => i.direction === "credit");
  return {
    ...b,
    state: b.reversal_id ? "reversed" : b.status,
    items,
    total: money(sum(items.map((i) => i.amount))),
    receivables: money(
      sum(
        debt.filter((i) => i.kind === "customer").map((i) => i.amount),
      ),
    ),
    payables: money(
      sum(
        debt.filter((i) => i.kind === "supplier").map((i) => i.amount),
      ),
    ),
    customer_credits: money(
      sum(
        credits.filter((i) => i.kind === "customer").map((i) => i.amount),
      ),
    ),
    supplier_credits: money(
      sum(
        credits.filter((i) => i.kind === "supplier").map((i) => i.amount),
      ),
    ),
  };
}
export async function listOpeningBatches(ctx: Context, q: any) {
  requirePermission(ctx, "accounting.read");
  const { page, limit, offset } = pageArgs(q);
  const r = await ctx.db.query(
    "SELECT b.*,u.name AS created_by_name,CASE WHEN r.id IS NOT NULL THEN 'reversed' ELSE b.status END AS state,(SELECT coalesce(sum(i.amount),0)::text FROM opening_items i WHERE i.company_id=b.company_id AND i.batch_id=b.id) AS total,count(*) OVER()::int AS _count FROM opening_batches b JOIN identities u ON u.company_id=b.company_id AND u.id=b.created_by LEFT JOIN opening_batch_reversals r ON r.company_id=b.company_id AND r.batch_id=b.id WHERE b.company_id=$1 AND b.branch_id=ANY($2::uuid[]) AND (b.number ILIKE $3 OR b.reference ILIKE $3) ORDER BY b.created_at DESC LIMIT $4 OFFSET $5",
    [
      ctx.companyId,
      ctx.actor.branch_ids,
      "%" + String(q.q ?? "").slice(0, 120) + "%",
      limit,
      offset,
    ],
  );
  return {
    items: r.rows.map(({ _count, ...x }) => x),
    total: r.rows[0]?._count ?? 0,
    page,
    limit,
  };
}
export async function transitionOpeningBatch(
  ctx: Context,
  id: string,
  status: "submitted" | "draft" | "cancelled",
  reason: string,
) {
  requirePermission(ctx, "accounting.post");
  const b = await one(
    ctx,
    "SELECT * FROM opening_batches WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, b.branch_id);
  if (
    !(
      (b.status === "draft" && ["submitted", "cancelled"].includes(status)) ||
      (b.status === "submitted" && ["draft", "cancelled"].includes(status))
    )
  )
    fail(409, "OPENING_STATE", "Invalid draft/submission transition");
  await ctx.db.query(
    "UPDATE opening_batches SET status=$1 WHERE company_id=$2 AND id=$3",
    [status, ctx.companyId, id],
  );
  await audit(
    ctx,
    status,
    "opening_batch",
    id,
    { status: b.status },
    { status },
    reason,
  );
  return getOpeningBatch(ctx, id);
}
export async function postOpeningBatch(
  ctx: Context,
  id: string,
  reason: string,
) {
  requirePermission(ctx, "accounting.post");
  requirePermission(ctx, "accounting.close");
  const hint = await one(
    ctx,
    "SELECT branch_id,accounting_date::text AS date FROM opening_batches WHERE company_id=$1 AND id=$2",
    [ctx.companyId, id],
  );
  branchAccess(ctx, hint.branch_id);
  const date = await accountingDate(ctx, hint.date);
  const b = await one(
    ctx,
    "SELECT * FROM opening_batches WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  if (b.status !== "submitted")
    fail(
      409,
      "OPENING_SUBMITTED_ONLY",
      "Only a reviewed submitted opening batch may be posted",
    );
  const items = (
    await ctx.db.query(
      "SELECT * FROM opening_items WHERE company_id=$1 AND batch_id=$2 ORDER BY id",
      [ctx.companyId, id],
    )
  ).rows;
  await lockParties(ctx, items);
  await ctx.db.query("SELECT lock_opening_boundary($1,$2)", [
    ctx.companyId,
    b.branch_id,
  ]);
  const state = await openingMetadata(ctx, b.branch_id);
  if (state.cutover && state.cutover !== date)
    fail(
      409,
      "OPENING_CUTOVER_FIXED",
      "Use the branch’s already fixed cutover date",
    );
  if (state.first_activity && date >= state.first_activity)
    fail(
      409,
      "OPENING_AFTER_ACTIVITY",
      "Cutover must precede all existing branch sales, invoices and settlements; importing is not permission to duplicate their debts",
    );
  const total = money(sum(items.map((i) => i.amount)));
  await checkApproval(ctx, b.created_by, total, reason);
  await ctx.db.query(
    "UPDATE opening_batches SET status='posted',posted_by=$1,posted_at=now(),approval_reason=$2 WHERE company_id=$3 AND id=$4",
    [ctx.actor.id, reason, ctx.companyId, id],
  );
  const lines: PostingLine[] = items.map((i) =>
    i.direction === "debt"
      ? {
          account: i.kind === "customer" ? "ar" : "ap",
          ...(i.kind === "customer"
            ? { debit: i.amount, customerId: i.customer_id }
            : { credit: i.amount, supplierId: i.supplier_id }),
          memo: `Legacy ${i.reference}: ${i.description}`,
        }
      : {
          account:
            i.kind === "customer" ? "customer_advances" : "supplier_advances",
          ...(i.kind === "customer"
            ? { credit: i.amount, customerId: i.customer_id }
            : { debit: i.amount, supplierId: i.supplier_id }),
          memo: `Legacy advance ${i.reference}: ${i.description}`,
        },
  );
  const debtCust = sum(
      items
        .filter((i) => i.direction === "debt" && i.kind === "customer")
        .map((i) => i.amount),
    ),
    debtSupp = sum(
      items
        .filter((i) => i.direction === "debt" && i.kind === "supplier")
        .map((i) => i.amount),
    ),
    credCust = sum(
      items
        .filter((i) => i.direction === "credit" && i.kind === "customer")
        .map((i) => i.amount),
    ),
    credSupp = sum(
      items
        .filter((i) => i.direction === "credit" && i.kind === "supplier")
        .map((i) => i.amount),
    );
  const net = debtCust.plus(credSupp).minus(debtSupp).minus(credCust);
  if (!net.eq(0))
    lines.push({
      account: "equity",
      ...(net.gt(0) ? { credit: money(net) } : { debit: money(net.abs()) }),
      memo: "Opening balance carry-forward, not revenue or input/output tax",
    });
  await postJournal(ctx, {
    branchId: b.branch_id,
    date,
    sourceType: "opening_balance",
    sourceId: id,
    description: `${b.number} · Legacy AR/AP carry-forward: ${b.reference}`,
    lines,
  });
  for (const i of items.filter((i) => i.direction === "credit"))
    await ctx.db.query(
      `INSERT INTO advance_credits(company_id,branch_id,${i.kind}_id,source_type,source_id,amount,accounting_date,created_by) VALUES($1,$2,$3,'opening_balance',$4,$5,$6,$7)`,
      [
        ctx.companyId,
        b.branch_id,
        i.kind === "customer" ? i.customer_id : i.supplier_id,
        i.id,
        money(i.amount),
        date,
        ctx.actor.id,
      ],
    );
  await audit(
    ctx,
    "post",
    "opening_batch",
    id,
    b,
    { total, items: items.length },
    reason,
  );
  return getOpeningBatch(ctx, id);
}
export async function reverseOpeningBatch(
  ctx: Context,
  id: string,
  input: { reason: string; accounting_date?: string },
) {
  requirePermission(ctx, "accounting.close");
  requirePermission(ctx, "accounting.reverse");
  const hint = await one(
    ctx,
    "SELECT branch_id,accounting_date::text AS date FROM opening_batches WHERE company_id=$1 AND id=$2",
    [ctx.companyId, id],
  );
  branchAccess(ctx, hint.branch_id);
  if (input.accounting_date && input.accounting_date !== hint.date)
    fail(
      409,
      "OPENING_REVERSAL_DATE",
      "Reverse an unused import at its original cutover, in an explicitly open period, to avoid doubling historical aging",
    );
  const date = await accountingDate(ctx, hint.date),
    b = await one(
      ctx,
      "SELECT b.*,b.accounting_date::text AS date FROM opening_batches b WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, id],
    );
  branchAccess(ctx, b.branch_id);
  if (
    b.status !== "posted" ||
    (
      await ctx.db.query(
        "SELECT id FROM opening_batch_reversals WHERE company_id=$1 AND batch_id=$2",
        [ctx.companyId, id],
      )
    ).rowCount
  )
    fail(
      409,
      "OPENING_NOT_REVERSIBLE",
      "Only an unreversed posted batch may be reversed",
    );
  if (date !== b.date)
    fail(
      409,
      "OPENING_REVERSAL_DATE",
      "Unused reversal must match the original effective cutover date",
    );
  const items = (
    await ctx.db.query(
      "SELECT * FROM opening_items WHERE company_id=$1 AND batch_id=$2",
      [ctx.companyId, id],
    )
  ).rows;
  await lockParties(ctx, items);
  await ctx.db.query("SELECT lock_opening_boundary($1,$2)", [
    ctx.companyId,
    b.branch_id,
  ]);
  if (
    (
      await ctx.db.query(
        "SELECT 1 FROM opening_allocations a JOIN opening_items i ON i.company_id=a.company_id AND i.id=a.item_id WHERE a.company_id=$1 AND i.batch_id=$2 LIMIT 1",
        [ctx.companyId, id],
      )
    ).rowCount
  )
    fail(
      409,
      "OPENING_ALREADY_ALLOCATED",
      "This batch has settled items; accountant-led correction is required instead of reversing received/paid money",
    );
  if (
    (
      await ctx.db.query(
        "SELECT 1 FROM advance_uses u JOIN advance_credits c ON c.company_id=u.company_id AND c.id=u.credit_id AND c.source_type='opening_balance' JOIN opening_items i ON i.company_id=c.company_id AND i.id=c.source_id WHERE u.company_id=$1 AND i.batch_id=$2 LIMIT 1",
        [ctx.companyId, id],
      )
    ).rowCount
  )
    fail(
      409,
      "OPENING_CREDIT_CONSUMED",
      "An imported legacy credit was already applied; use an accountant-led correction instead of reversing settled credit history",
    );
  await checkApproval(
    ctx,
    b.posted_by,
    money(sum(items.map((i) => i.amount))),
    input.reason,
  );
  const reversalId = randomUUID(),
    number = await nextNumber(ctx, "OBR");
  await ctx.db.query(
    "INSERT INTO opening_batch_reversals(id,company_id,batch_id,number,accounting_date,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [reversalId, ctx.companyId, id, number, date, input.reason, ctx.actor.id],
  );
  // Withdraw the still-unused imported credits append-only so they can never
  // settle future debt after the reversal; the flipped journal above covers GL.
  await ctx.db.query(
    "INSERT INTO advance_uses(company_id,credit_id,target_type,target_id,amount,accounting_date) SELECT c.company_id,c.id,'opening_reversal',$1,c.amount,$2 FROM advance_credits c JOIN opening_items i ON i.company_id=c.company_id AND i.id=c.source_id WHERE c.company_id=$3 AND c.source_type='opening_balance' AND i.batch_id=$4",
    [reversalId, date, ctx.companyId, id],
  );
  const j = await one(
      ctx,
      "SELECT id FROM journals WHERE company_id=$1 AND source_type='opening_balance' AND source_id=$2",
      [ctx.companyId, id],
    ),
    old = (
      await ctx.db.query(
        "SELECT * FROM journal_lines WHERE company_id=$1 AND journal_id=$2",
        [ctx.companyId, j.id],
      )
    ).rows;
  await postJournal(ctx, {
    branchId: b.branch_id,
    date,
    sourceType: "opening_balance_reversal",
    sourceId: reversalId,
    reversalOf: j.id,
    description: `${number} · Reverse unused ${b.number}: ${input.reason}`,
    lines: old.map((l) => ({
      account: l.account_id,
      byId: true,
      debit: l.credit,
      credit: l.debit,
      customerId: l.customer_id,
      supplierId: l.supplier_id,
      memo: "Opening balance reversal, no cash/tax/stock",
    })),
  });
  await audit(
    ctx,
    "reverse_unused",
    "opening_batch",
    id,
    null,
    { reversal_id: reversalId, number },
    input.reason,
  );
  return getOpeningBatch(ctx, id);
}
export async function openingDebtOutstanding(ctx: Context, id: string) {
  const hint = await one(
    ctx,
    "SELECT i.kind,i.customer_id,i.supplier_id,b.branch_id FROM opening_items i JOIN opening_batches b ON b.company_id=i.company_id AND b.id=i.batch_id WHERE i.company_id=$1 AND i.id=$2",
    [ctx.companyId, id],
  );
  branchAccess(ctx, hint.branch_id);
  await lockParties(ctx, [hint]);
  await one(
    ctx,
    "SELECT id FROM opening_items WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  const doc = await one(
    ctx,
    "SELECT i.*,b.branch_id,b.number,b.accounting_date::text AS document_date,opening_item_balance(i.company_id,i.id)::text AS outstanding FROM opening_items i JOIN opening_batches b ON b.company_id=i.company_id AND b.id=i.batch_id WHERE i.company_id=$1 AND i.id=$2 AND i.direction='debt' AND b.status='posted' AND NOT EXISTS(SELECT 1 FROM opening_batch_reversals r WHERE r.company_id=b.company_id AND r.batch_id=b.id)",
    [ctx.companyId, id],
  );
  return { ...doc, total: doc.amount, document_type: "opening" };
}
export async function insertOpeningAllocation(
  ctx: Context,
  input: {
    id?: string;
    itemId: string;
    amount: string;
    date: string;
    receiptId?: string;
    paymentId?: string;
    creditId?: string;
  },
) {
  const id = input.id ?? randomUUID();
  await ctx.db.query(
    "INSERT INTO opening_allocations(id,company_id,item_id,receipt_id,payment_id,credit_id,amount,accounting_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      id,
      ctx.companyId,
      input.itemId,
      input.receiptId ?? null,
      input.paymentId ?? null,
      input.creditId ?? null,
      input.amount,
      input.date,
      ctx.actor.id,
    ],
  );
  return id;
}
export async function applyCreditToOpening(
  ctx: Context,
  id: string,
  input: {
    credit_id: string;
    amount: string;
    accounting_date?: string;
    reason: string;
  },
) {
  const hint = await one(
    ctx,
    "SELECT kind FROM opening_items WHERE company_id=$1 AND id=$2",
    [ctx.companyId, id],
  );
  requirePermission(
    ctx,
    hint.kind === "customer" ? "payments.receive" : "payments.pay",
  );
  const date = await accountingDate(ctx, input.accounting_date),
    doc = await openingDebtOutstanding(ctx, id);
  const credit = await one(
    ctx,
    "SELECT * FROM advance_credits WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, input.credit_id],
  );
  if (
    credit.branch_id !== doc.branch_id ||
    credit.customer_id !== doc.customer_id ||
    credit.supplier_id !== doc.supplier_id
  )
    fail(
      422,
      "OPENING_CREDIT_CONTACT",
      "Credit must belong to the same party and branch",
    );
  if (
    date <= doc.document_date ||
    D(input.amount).gt(doc.outstanding) ||
    !D(input.amount).gt(0)
  )
    fail(
      409,
      "OPENING_CREDIT_AMOUNT_DATE",
      "Credit exceeds open debt or is not after its cutover",
    );
  const allocationId = randomUUID();
  await consumeAdvance(ctx, {
    kind: doc.kind,
    contactId: doc.customer_id ?? doc.supplier_id,
    branchId: doc.branch_id,
    targetType: "opening_allocation",
    targetId: allocationId,
    amount: input.amount,
    date,
    creditId: credit.id,
  });
  await insertOpeningAllocation(ctx, {
    id: allocationId,
    itemId: id,
    amount: input.amount,
    date,
    creditId: credit.id,
  });
  const contact =
    doc.kind === "customer"
      ? { customerId: doc.customer_id }
      : { supplierId: doc.supplier_id };
  await postJournal(ctx, {
    branchId: doc.branch_id,
    date,
    sourceType: "opening_allocation",
    sourceId: allocationId,
    description: `Apply available credit to ${doc.reference}`,
    lines:
      doc.kind === "customer"
        ? [
            { account: "customer_advances", debit: input.amount, ...contact },
            { account: "ar", credit: input.amount, ...contact },
          ]
        : [
            { account: "ap", debit: input.amount, ...contact },
            { account: "supplier_advances", credit: input.amount, ...contact },
          ],
  });
  await audit(
    ctx,
    "apply_credit",
    "opening_item",
    id,
    null,
    { allocation_id: allocationId, credit_id: credit.id, amount: input.amount },
    input.reason,
  );
  return {
    id: allocationId,
    amount: input.amount,
    outstanding: money(D(doc.outstanding).minus(input.amount)),
  };
}
