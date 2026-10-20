import { D, money, qty, sum, assertTransition } from "@duka/shared";
import { randomUUID } from "node:crypto";
import {
  one,
  fail,
  requirePermission,
  branchAccess,
  warehouseAccess,
  audit,
  nextNumber,
  accountingDate,
  uniqueIds,
  type Context,
} from "../db.ts";
import { priceCart } from "./catalog.ts";
import { postJournal, type PostingLine } from "@duka/accounting";
import { lockStock } from "@duka/inventory";
import { checkApproval } from "./shifts.ts";
import { recordPayment } from "./payments.ts";
import { createPurchaseOrder } from "./procurement.ts";
export async function createDocument(ctx: Context, input: any) {
  requirePermission(ctx, "documents.write");
  branchAccess(ctx, input.branch_id);
  let deliverySnapshot: any = null;
  if (input.warehouse_id) {
    const w = await warehouseAccess(ctx, input.warehouse_id);
    if (w.branch_id !== input.branch_id)
      fail(422, "BRANCH_MISMATCH", "Warehouse is in a different branch");
  }
  if (input.kind === "sales_order" && !input.warehouse_id)
    fail(422, "WAREHOUSE_REQUIRED", "Sales orders require a warehouse");
  if (input.kind === "delivery_note") {
    if (!input.sale_id)
      fail(
        422,
        "SALE_REQUIRED",
        "Delivery notes must reference a posted sale; stock is issued by the sale, not twice",
      );
    const sale = await one(
      ctx,
      "SELECT * FROM sales WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, input.sale_id],
    );
    branchAccess(ctx, sale.branch_id);
    if (sale.branch_id !== input.branch_id)
      fail(422, "BRANCH_MISMATCH", "Sale belongs to another branch");
    input = {
      ...input,
      customer_id: sale.customer_id ?? undefined,
      warehouse_id: sale.warehouse_id,
    };
    const existing = await ctx.db.query(
      "SELECT 1 FROM business_documents WHERE company_id=$1 AND sale_id=$2 AND kind='delivery_note' AND status<>'cancelled' LIMIT 1",
      [ctx.companyId, sale.id],
    );
    if (existing.rowCount)
      fail(
        409,
        "DELIVERY_EXISTS",
        "A delivery note already exists for this sale",
      );
    const originals = (
      await ctx.db.query(
        "SELECT product_id,description AS name,quantity,base_quantity,unit_id,unit_price,discount,tax_rate,tax_kind,net,tax,total,batch_id,serials FROM sale_lines WHERE company_id=$1 AND sale_id=$2",
        [ctx.companyId, sale.id],
      )
    ).rows;
    deliverySnapshot = {
      lines: originals,
      subtotal: sale.subtotal,
      tax: sale.tax,
      total: sale.total,
    };
  }
  if (input.source_id) {
    const source = await one(
      ctx,
      "SELECT * FROM business_documents WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, input.source_id],
    );
    branchAccess(ctx, source.branch_id);
    if (
      source.status !== "approved" ||
      source.kind !== "quotation" ||
      input.kind !== "sales_order"
    )
      fail(
        409,
        "INVALID_CONVERSION",
        "Only an approved quotation may become a sales order",
      );
    input = {
      ...input,
      branch_id: source.branch_id,
      customer_id: source.customer_id ?? undefined,
      warehouse_id: source.warehouse_id ?? input.warehouse_id,
      lines: source.lines.map((l: any) => ({
        product_id: l.product_id,
        quantity: l.quantity,
        unit_id: l.unit_id,
        serials: [],
      })),
    };
  }
  if (input.warehouse_id) {
    const w = await warehouseAccess(ctx, input.warehouse_id);
    if (w.branch_id !== input.branch_id)
      fail(422, "BRANCH_MISMATCH", "Warehouse is in a different branch");
  }
  const date = await accountingDate(ctx);
  let priced: any;
  if (deliverySnapshot) priced = deliverySnapshot;
  else if (input.kind === "requisition") {
    const lines = [];
    for (const l of input.lines) {
      const p = await one(
        ctx,
        "SELECT * FROM products WHERE company_id=$1 AND id=$2 AND active",
        [ctx.companyId, l.product_id],
      );
      const u = await one(
        ctx,
        "SELECT fractional FROM units WHERE company_id=$1 AND id=$2",
        [ctx.companyId, l.unit_id ?? p.unit_id],
      );
      if (!u.fractional && !D(l.quantity).isInteger())
        fail(
          422,
          "WHOLE_QUANTITY_REQUIRED",
          "Requisition selling unit requires a whole quantity",
        );
      const factor =
        l.unit_id && l.unit_id !== p.unit_id
          ? (
              await one(
                ctx,
                "SELECT factor FROM product_units WHERE company_id=$1 AND product_id=$2 AND unit_id=$3",
                [ctx.companyId, p.id, l.unit_id],
              )
            ).factor
          : "1";
      const base = qty(D(l.quantity).times(factor));
      lines.push({
        ...l,
        name: p.name,
        unit_price: qty(D(p.purchase_cost).times(factor)),
        base_unit_cost: p.purchase_cost,
        base_quantity: base,
        total: money(D(base).times(p.purchase_cost)),
      });
    }
    priced = {
      lines,
      subtotal: money(sum(lines.map((l) => l.total))),
      tax: "0.00",
      total: money(sum(lines.map((l) => l.total))),
    };
  } else
    priced = await priceCart(
      ctx,
      {
        lines: input.lines,
        customer_id: input.customer_id,
        discount_percent: "0",
      },
      date,
    );
  const lines = priced.lines.map(({ product, ...l }: any) => ({
    ...l,
    name: product?.name ?? l.name,
  }));
  const id = randomUUID(),
    number = await nextNumber(
      ctx,
      {
        quotation: "QTN",
        sales_order: "SO",
        delivery_note: "DN",
        requisition: "PR",
      }[input.kind as string] ?? "DOC",
    );
  await ctx.db.query(
    "INSERT INTO business_documents(id,company_id,branch_id,warehouse_id,number,kind,customer_id,supplier_id,source_id,sale_id,lines,subtotal,tax,total,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
    [
      id,
      ctx.companyId,
      input.branch_id,
      input.warehouse_id ?? null,
      number,
      input.kind,
      input.customer_id ?? null,
      input.supplier_id ?? null,
      input.source_id ?? null,
      input.sale_id ?? null,
      JSON.stringify(lines),
      priced.subtotal,
      priced.tax,
      priced.total,
      input.notes ?? null,
      ctx.actor.id,
    ],
  );
  if (input.source_id)
    await ctx.db.query(
      "UPDATE business_documents SET status='converted' WHERE company_id=$1 AND id=$2",
      [ctx.companyId, input.source_id],
    );
  await audit(ctx, "create", "document", id, null, {
    number,
    kind: input.kind,
    total: priced.total,
  });
  return { id, number, kind: input.kind, status: "draft", total: priced.total };
}
export async function transitionDocument(
  ctx: Context,
  id: string,
  status: string,
  reason: string,
) {
  requirePermission(ctx, "documents.write");
  const d = await one(
    ctx,
    "SELECT * FROM business_documents WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, d.branch_id);
  if (d.warehouse_id) await warehouseAccess(ctx, d.warehouse_id);
  try {
    assertTransition("document", d.status, status);
  } catch (e: any) {
    fail(409, "INVALID_STATE", e.message);
  }
  if (status === "converted")
    fail(
      422,
      "CONVERSION_WORKFLOW",
      "Use checkout or conversion endpoints to convert a document",
    );
  if (["approved", "rejected"].includes(status)) {
    requirePermission(
      ctx,
      d.kind === "requisition" ? "purchases.approve" : "sales.price_override",
    );
    await checkApproval(ctx, d.created_by, d.total, reason);
  }
  if (status === "approved" && d.kind === "sales_order") {
    const needs = new Map<string, string>();
    for (const l of d.lines) {
      const p = await one(
        ctx,
        "SELECT kind FROM products WHERE company_id=$1 AND id=$2",
        [ctx.companyId, l.product_id],
      );
      if (p.kind === "service") continue;
      if (p.kind === "bundle") {
        const comps = (
          await ctx.db.query(
            "SELECT * FROM bundle_components WHERE company_id=$1 AND bundle_id=$2",
            [ctx.companyId, l.product_id],
          )
        ).rows;
        for (const c of comps)
          needs.set(
            c.product_id,
            qty(
              D(needs.get(c.product_id) ?? 0).plus(
                D(c.quantity).times(l.base_quantity),
              ),
            ),
          );
      } else
        needs.set(
          l.product_id,
          qty(D(needs.get(l.product_id) ?? 0).plus(l.base_quantity)),
        );
    }
    await lockStock(
      ctx,
      [...needs.keys()].map((productId) => ({
        productId,
        warehouseId: d.warehouse_id,
      })),
    );
    const c = await one(ctx, "SELECT settings FROM companies WHERE id=$1", [
      ctx.companyId,
    ]);
    for (const [productId, q] of needs) {
      const b = await one(
        ctx,
        "SELECT * FROM stock_balances WHERE company_id=$1 AND product_id=$2 AND warehouse_id=$3 FOR UPDATE",
        [ctx.companyId, productId, d.warehouse_id],
      );
      const available = D(b.quantity).minus(b.reserved);
      if (D(q).gt(available) && !c.settings.allowBackorders)
        fail(
          409,
          "RESERVATION_STOCK",
          "Insufficient stock to reserve this order",
        );
      const reserved = D(q).lte(available) ? D(q) : available;
      if (reserved.gt(0)) {
        await ctx.db.query(
          "UPDATE stock_balances SET reserved=reserved+$1 WHERE company_id=$2 AND product_id=$3 AND warehouse_id=$4",
          [qty(reserved), ctx.companyId, productId, d.warehouse_id],
        );
        await ctx.db.query(
          "INSERT INTO stock_reservations(company_id,document_id,product_id,warehouse_id,quantity) VALUES($1,$2,$3,$4,$5)",
          [ctx.companyId, id, productId, d.warehouse_id, qty(reserved)],
        );
      }
    }
  }
  if (status === "cancelled") {
    const reservations = (
      await ctx.db.query(
        "SELECT * FROM stock_reservations WHERE company_id=$1 AND document_id=$2 AND status='active' ORDER BY product_id FOR UPDATE",
        [ctx.companyId, id],
      )
    ).rows;
    await lockStock(
      ctx,
      reservations.map((r) => ({
        productId: r.product_id,
        warehouseId: r.warehouse_id,
      })),
    );
    for (const r of reservations) {
      await ctx.db.query(
        "UPDATE stock_balances SET reserved=reserved-$1 WHERE company_id=$2 AND product_id=$3 AND warehouse_id=$4",
        [r.quantity, ctx.companyId, r.product_id, r.warehouse_id],
      );
      await ctx.db.query(
        "UPDATE stock_reservations SET status='released' WHERE company_id=$1 AND id=$2",
        [ctx.companyId, r.id],
      );
    }
  }
  await ctx.db.query(
    "UPDATE business_documents SET status=$1,approved_by=CASE WHEN $1='approved' THEN $2 ELSE approved_by END WHERE company_id=$3 AND id=$4",
    [status, ctx.actor.id, ctx.companyId, id],
  );
  await audit(
    ctx,
    status,
    "document",
    id,
    { status: d.status },
    { status },
    reason,
  );
  return { id, status };
}
export async function requisitionToOrder(
  ctx: Context,
  id: string,
  supplierId: string,
) {
  const d = await one(
    ctx,
    "SELECT * FROM business_documents WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, d.branch_id);
  if (d.kind !== "requisition" || d.status !== "approved" || !d.warehouse_id)
    fail(
      409,
      "INVALID_CONVERSION",
      "An approved requisition with a warehouse is required",
    );
  const po = await createPurchaseOrder(ctx, {
    warehouse_id: d.warehouse_id,
    supplier_id: supplierId,
    notes: `From ${d.number}`,
    lines: d.lines.map((l: any) => ({
      product_id: l.product_id,
      quantity: l.base_quantity,
      unit_cost:
        l.base_unit_cost ??
        qty(D(l.unit_price).times(l.quantity).div(l.base_quantity)),
    })),
  });
  await ctx.db.query(
    "UPDATE business_documents SET status='converted',notes=coalesce(notes,'')||$1 WHERE company_id=$2 AND id=$3",
    [`\nConverted to ${po.number}`, ctx.companyId, id],
  );
  await audit(ctx, "convert", "document", id, null, {
    purchase_order_id: po.id,
  });
  return po;
}
export async function createExpense(ctx: Context, input: any) {
  requirePermission(ctx, "expenses.create");
  branchAccess(ctx, input.branch_id);
  const date = await accountingDate(ctx, input.accounting_date);
  await one(
    ctx,
    "SELECT id FROM expense_categories WHERE company_id=$1 AND id=$2",
    [ctx.companyId, input.category_id],
  );
  const t = await one(
    ctx,
    "SELECT * FROM tax_rules WHERE company_id=$1 AND id=$2 AND active AND valid_from<=$3::date AND (valid_to IS NULL OR valid_to>=$3::date)",
    [ctx.companyId, input.tax_rule_id, date],
  );
  const tax = money(D(input.net).times(t.rate).div(100)),
    total = money(D(input.net).plus(tax));
  if (D(total).lte(0)) fail(422, "EXPENSE_AMOUNT", "Expense must be positive");
  const id = randomUUID(),
    number = await nextNumber(ctx, "EXP");
  await ctx.db.query(
    "INSERT INTO expenses(id,company_id,branch_id,category_id,supplier_id,number,description,net,tax,total,created_by,accounting_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [
      id,
      ctx.companyId,
      input.branch_id,
      input.category_id,
      input.supplier_id ?? null,
      number,
      input.description,
      input.net,
      tax,
      total,
      ctx.actor.id,
      date,
    ],
  );
  await audit(ctx, "submit", "expense", id, null, { number, total, ...input });
  return { id, number, status: "submitted", net: input.net, tax, total };
}
export async function reviewExpense(
  ctx: Context,
  id: string,
  status: "approved" | "rejected",
  reason: string,
) {
  requirePermission(ctx, "expenses.approve");
  const e = await one(
    ctx,
    "SELECT * FROM expenses WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, e.branch_id);
  try {
    assertTransition("expense", e.status, status);
  } catch (err: any) {
    fail(409, "INVALID_STATE", err.message);
  }
  await checkApproval(ctx, e.created_by, e.total, reason);
  await ctx.db.query(
    "UPDATE expenses SET status=$1,approved_by=$2,approval_reason=$3 WHERE company_id=$4 AND id=$5",
    [status, ctx.actor.id, reason, ctx.companyId, id],
  );
  await audit(
    ctx,
    status,
    "expense",
    id,
    { status: e.status },
    { status },
    reason,
  );
  return { id, status };
}
export async function payExpense(ctx: Context, id: string, input: any) {
  requirePermission(ctx, "expenses.pay");
  const e = await one(
    ctx,
    "SELECT e.*,c.account_id FROM expenses e JOIN expense_categories c ON c.company_id=e.company_id AND c.id=e.category_id WHERE e.company_id=$1 AND e.id=$2 FOR UPDATE OF e",
    [ctx.companyId, id],
  );
  branchAccess(ctx, e.branch_id);
  if (e.status !== "approved")
    fail(
      409,
      "EXPENSE_NOT_APPROVED",
      "Expense must be approved before posting",
    );
  if (!D(input.payment.amount).eq(e.total))
    fail(
      422,
      "EXPENSE_PAYMENT",
      "Payment must match the approved expense total",
    );
  const date = await accountingDate(ctx, input.accounting_date);
  const pay = await recordPayment(ctx, input.payment, {
    branchId: e.branch_id,
    shiftId: input.shift_id,
    sourceType: "expense",
    sourceId: id,
    direction: "out",
    date,
  });
  await postJournal(ctx, {
    branchId: e.branch_id,
    date,
    sourceType: "expense",
    sourceId: id,
    description: `${e.number} · ${e.description}`,
    lines: [
      { account: e.account_id, byId: true, debit: e.net },
      { account: "tax_input", debit: e.tax },
      { account: pay.account, byId: true, credit: e.total },
    ],
  });
  await ctx.db.query(
    "UPDATE expenses SET status='posted' WHERE company_id=$1 AND id=$2",
    [ctx.companyId, id],
  );
  await audit(ctx, "post", "expense", id, null, { payment_id: pay.id });
  return { id, status: "posted", total: e.total };
}
export async function acquireAsset(ctx: Context, input: any) {
  requirePermission(ctx, "accounting.post");
  branchAccess(ctx, input.branch_id);
  const date = await accountingDate(ctx, input.acquired_date);
  if (D(input.residual).gt(input.cost))
    fail(422, "RESIDUAL_VALUE", "Residual exceeds asset cost");
  const funding = input.funding ?? "opening",
    tax = money(D(input.tax ?? 0));
  if (funding === "opening" && D(tax).gt(0))
    fail(422, "ASSET_TAX", "Opening assets carry no new input tax");
  const accounts = await ctx.db.query(
    "SELECT id,system_key FROM accounts WHERE company_id=$1 AND system_key IN ('fixed_assets','accumulated_depreciation','depreciation')",
    [ctx.companyId],
  );
  const ids = Object.fromEntries(
    accounts.rows.map((a) => [a.system_key, a.id]),
  );
  const id = randomUUID();
  let payment: any = null;
  if (funding === "payment") {
    const total = money(D(input.cost).plus(tax));
    if (!input.payment || !D(input.payment.amount ?? total).eq(total))
      fail(
        422,
        "ASSET_PAYMENT",
        "A paid acquisition needs a recorded tender equal to cost plus tax",
      );
    payment = await recordPayment(ctx, input.payment, {
      branchId: input.branch_id,
      shiftId: input.shift_id,
      sourceType: "asset_acquisition",
      sourceId: id,
      direction: "out",
      date,
    });
  }
  // The DB trigger independently re-verifies the tender binding above.
  await ctx.db.query(
    "INSERT INTO fixed_assets(id,company_id,branch_id,name,cost,residual,useful_months,acquired_date,asset_account_id,accumulated_account_id,expense_account_id,funding,acquisition_tax,acquisition_payment_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
    [
      id,
      ctx.companyId,
      input.branch_id,
      input.name,
      input.cost,
      input.residual,
      input.useful_months,
      date,
      ids.fixed_assets,
      ids.accumulated_depreciation,
      ids.depreciation,
      funding,
      tax,
      payment?.id ?? null,
      ctx.actor.id,
    ],
  );
  const lines: PostingLine[] = [
    { account: ids.fixed_assets, byId: true, debit: input.cost },
  ];
  if (D(tax).gt(0)) lines.push({ account: "tax_input", debit: tax });
  if (funding === "payment")
    lines.push({ account: payment.account, byId: true, credit: money(D(input.cost).plus(tax)) });
  else lines.push({ account: "equity", credit: input.cost });
  await postJournal(ctx, {
    branchId: input.branch_id,
    date,
    sourceType: funding === "payment" ? "asset_acquisition" : "asset_opening",
    sourceId: id,
    description: `${funding === "payment" ? "Acquired" : "Opening"} asset: ${input.name}`,
    lines,
  });
  await audit(ctx, funding === "payment" ? "acquire" : "opening", "fixed_asset", id, null, input);
  return { id, ...input, funding, tax, payment_id: payment?.id ?? null };
}

export async function disposeAsset(ctx: Context, id: string, input: any) {
  requirePermission(ctx, "accounting.post");
  const a = await one(
    ctx,
    "SELECT * FROM fixed_assets WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, a.branch_id);
  if (a.status !== "active")
    fail(409, "ASSET_DISPOSED", "Asset is already disposed");
  const date = await accountingDate(ctx, input.accounting_date);
  const acc = D(
    (
      await one(
        ctx,
        "SELECT coalesce(sum(amount),0)::text AS n FROM depreciation_runs WHERE company_id=$1 AND asset_id=$2",
        [ctx.companyId, id],
      )
    ).n,
  );
  const nbv = D(a.cost).minus(acc),
    proceeds = money(D(input.proceeds ?? 0)),
    gain = money(D(proceeds).minus(nbv).abs().mul(D(proceeds).gt(nbv) ? 1 : 0)),
    loss = money(D(nbv).minus(proceeds).abs().mul(D(proceeds).lt(nbv) ? 1 : 0));
  await checkApproval(ctx, a.created_by, money(nbv), input.reason);
  const disposalId = randomUUID(),
    number = await nextNumber(ctx, "FAD");
  let payment: any = null;
  if (D(proceeds).gt(0)) {
    if (!input.payment)
      fail(
        422,
        "DISPOSAL_PAYMENT",
        "Sale proceeds need an actual recorded incoming tender",
      );
    payment = await recordPayment(ctx, input.payment, {
      branchId: a.branch_id,
      shiftId: input.shift_id,
      sourceType: "asset_disposal",
      sourceId: disposalId,
      direction: "in",
      date,
    });
    if (!D(payment.amount).eq(proceeds))
      fail(422, "DISPOSAL_PAYMENT", "Proceeds must match the recorded tender");
  }
  // The DB guard recomputes cost/accumulation/gain/loss and tender matches.
  await ctx.db.query(
    "INSERT INTO asset_disposals(id,company_id,asset_id,branch_id,number,proceeds,cost,accumulated,net_book_value,gain,loss,payment_id,reason,accounting_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
    [
      disposalId,
      ctx.companyId,
      id,
      a.branch_id,
      number,
      proceeds,
      money(D(a.cost)),
      money(acc),
      money(nbv),
      gain,
      loss,
      payment?.id ?? null,
      input.reason,
      date,
      ctx.actor.id,
    ],
  );
  const lines: PostingLine[] = [];
  if (acc.gt(0))
    lines.push({
      account: a.accumulated_account_id,
      byId: true,
      debit: money(acc),
    });
  if (payment)
    lines.push({ account: payment.account, byId: true, debit: proceeds });
  if (D(loss).gt(0))
    lines.push({ account: "asset_disposal_loss", debit: loss });
  lines.push({ account: a.asset_account_id, byId: true, credit: money(D(a.cost)) });
  if (D(gain).gt(0))
    lines.push({ account: "asset_disposal_gain", credit: gain });
  await postJournal(ctx, {
    branchId: a.branch_id,
    date,
    sourceType: "asset_disposal",
    sourceId: disposalId,
    description: `Disposal of ${a.name} · ${number}`,
    lines,
  });
  await ctx.db.query(
    "UPDATE fixed_assets SET status='disposed' WHERE company_id=$1 AND id=$2",
    [ctx.companyId, id],
  );
  await audit(ctx, "dispose", "fixed_asset", id, null, {
    disposal_id: disposalId,
    number,
    proceeds,
    gain,
    loss,
    reason: input.reason,
  });
  return { id: disposalId, number, proceeds, gain, loss, net_book_value: money(nbv) };
}

async function expensePostedExpenseAccount(ctx: Context, expense: any) {
  const row = await ctx.db.query(
    `SELECT l.account_id AS id FROM journals j JOIN journal_lines l ON l.company_id=j.company_id AND l.journal_id=j.id JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE j.company_id=$1 AND j.source_type='expense' AND j.source_id=$2 AND a.type='expense' AND l.debit=$3 LIMIT 1`,
    [ctx.companyId, expense.id, expense.net],
  );
  if (!row.rows.length)
    fail(409, "EXPENSE_POSTING", "Expense has no original posting");
  return row.rows[0].id;
}

export async function voidExpense(ctx: Context, expenseId: string, input: any) {
  requirePermission(ctx, "expenses.approve");
  requirePermission(ctx, "expenses.pay");
  const e = await one(
    ctx,
    "SELECT * FROM expenses WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, expenseId],
  );
  branchAccess(ctx, e.branch_id);
  if (e.status !== "posted")
    fail(
      409,
      "EXPENSE_NOT_POSTED",
      "Only a posted expense with a recorded tender can be voided",
    );
  const originalAccount = await expensePostedExpenseAccount(ctx, e);
  const pay = await one(
    ctx,
    "SELECT p.*,m.account_id AS account FROM payments p JOIN payment_methods m ON m.company_id=p.company_id AND m.id=p.method_id WHERE p.company_id=$1 AND p.source_type='expense' AND p.source_id=$2",
    [ctx.companyId, expenseId],
  );
  await checkApproval(ctx, e.created_by, e.total, input.reason);
  const voidId = randomUUID(),
    number = await nextNumber(ctx, "EXPV");
  // Original effective date only; a closed original period blocks the journal.
  const date = e.accounting_date.toISOString
    ? e.accounting_date.toISOString().slice(0, 10)
    : String(e.accounting_date).slice(0, 10);
  // The DB trigger re-verifies status, refund/reclassification history,
  // snapshot equality, tender binding and the original-date rule.
  await ctx.db.query(
    "INSERT INTO expense_voids(id,company_id,expense_id,branch_id,number,payment_id,net,tax,total,reason,accounting_date,voided_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [
      voidId,
      ctx.companyId,
      expenseId,
      e.branch_id,
      number,
      pay.id,
      e.net,
      e.tax,
      e.total,
      input.reason,
      date,
      ctx.actor.id,
    ],
  );
  const lines: PostingLine[] = [
    { account: pay.account, byId: true, debit: e.total },
    { account: originalAccount, byId: true, credit: e.net },
  ];
  if (D(e.tax).gt(0)) lines.push({ account: "tax_input", credit: e.tax });
  await postJournal(ctx, {
    branchId: e.branch_id,
    date,
    sourceType: "expense_void",
    sourceId: voidId,
    description: `Void of ${e.number} · ${input.reason.slice(0, 80)}`,
    lines,
  });
  await ctx.db.query(
    "UPDATE expenses SET status='void' WHERE company_id=$1 AND id=$2",
    [ctx.companyId, expenseId],
  );
  await audit(ctx, "void", "expense", expenseId, { status: e.status }, { status: "void", void_id: voidId }, input.reason);
  return { id: voidId, number, status: "void", total: e.total };
}

export async function reclassifyExpense(
  ctx: Context,
  expenseId: string,
  input: any,
) {
  requirePermission(ctx, "expenses.approve");
  requirePermission(ctx, "accounting.post");
  const e = await one(
    ctx,
    "SELECT * FROM expenses WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, expenseId],
  );
  branchAccess(ctx, e.branch_id);
  if (e.status !== "posted")
    fail(
      409,
      "EXPENSE_NOT_POSTED",
      "Only a posted expense can be reclassified",
    );
  const originalAccount = await expensePostedExpenseAccount(ctx, e);
  await checkApproval(ctx, e.created_by, e.net, input.reason);
  const date = await accountingDate(ctx, input.accounting_date);
  if (input.to_account_id === originalAccount)
    fail(
      422,
      "RECLASSIFY_SAME",
      "Reclassification must move to a different expense account",
    );
  const rcId = randomUUID(),
    number = await nextNumber(ctx, "EXPRC");
  // The DB trigger recomputes the original account, the remaining net cap,
  // the date ordering, refund/void exclusivity and the target account type.
  await ctx.db.query(
    "INSERT INTO expense_reclassifications(id,company_id,expense_id,branch_id,number,from_account_id,to_account_id,amount,reason,accounting_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      rcId,
      ctx.companyId,
      expenseId,
      e.branch_id,
      number,
      originalAccount,
      input.to_account_id,
      input.amount,
      input.reason,
      date,
      ctx.actor.id,
    ],
  );
  await postJournal(ctx, {
    branchId: e.branch_id,
    date,
    sourceType: "expense_reclassification",
    sourceId: rcId,
    description: `Reclassify ${e.number} · ${number}`,
    lines: [
      { account: input.to_account_id, byId: true, debit: input.amount },
      { account: originalAccount, byId: true, credit: input.amount },
    ],
  });
  await audit(ctx, "reclassify", "expense", expenseId, null, {
    reclassification_id: rcId,
    number,
    from: originalAccount,
    to: input.to_account_id,
    amount: input.amount,
  });
  return { id: rcId, number, from_account_id: originalAccount };
}
export async function depreciateAsset(ctx: Context, id: string, date: string) {
  requirePermission(ctx, "accounting.post");
  const a = await one(
    ctx,
    "SELECT * FROM fixed_assets WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, a.branch_id);
  await accountingDate(ctx, date);
  const month = date.slice(0, 7) + "-01";
  if (month < a.acquired_date.toISOString().slice(0, 7) + "-01")
    fail(422, "DEPRECIATION_DATE", "Cannot depreciate before acquisition");
  const prior = (
    await ctx.db.query(
      "SELECT coalesce(sum(amount),0)::text AS n,count(*)::int AS months FROM depreciation_runs WHERE company_id=$1 AND asset_id=$2",
      [ctx.companyId, id],
    )
  ).rows[0];
  const remaining = D(a.cost).minus(a.residual).minus(prior.n);
  if (remaining.lte(0))
    fail(409, "FULLY_DEPRECIATED", "Asset is fully depreciated");
  const monthly = D(money(D(a.cost).minus(a.residual).div(a.useful_months)));
  const charge =
    prior.months >= a.useful_months - 1
      ? remaining
      : monthly.lt(remaining)
        ? monthly
        : remaining;
  if (charge.lte(0))
    fail(
      422,
      "DEPRECIATION_PRECISION",
      "Monthly depreciation is below currency precision",
    );
  const run = randomUUID();
  await ctx.db.query(
    "INSERT INTO depreciation_runs(id,company_id,asset_id,month,amount) VALUES($1,$2,$3,$4,$5)",
    [run, ctx.companyId, id, month, money(charge)],
  );
  await postJournal(ctx, {
    branchId: a.branch_id,
    date,
    sourceType: "depreciation",
    sourceId: run,
    description: `${a.name} · ${month}`,
    lines: [
      { account: a.expense_account_id, byId: true, debit: money(charge) },
      { account: a.accumulated_account_id, byId: true, credit: money(charge) },
    ],
  });
  await audit(ctx, "depreciate", "fixed_asset", id, null, {
    month,
    amount: money(charge),
  });
  return { id: run, amount: money(charge), month };
}
