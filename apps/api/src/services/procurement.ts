import { D, money, qty, sum, assertTransition } from "@duka/shared";
import { randomUUID } from "node:crypto";
import {
  one,
  fail,
  requirePermission,
  has,
  branchAccess,
  warehouseAccess,
  audit,
  nextNumber,
  accountingDate,
  uniqueIds,
  type Context,
  pageArgs,
} from "../db.ts";
import { lockStock, moveStock } from "@duka/inventory";
import { postJournal, type PostingLine } from "@duka/accounting";
import { checkApproval } from "./shifts.ts";
import { invoiceOutstanding } from "./payments.ts";
export async function createPurchaseOrder(ctx: Context, input: any) {
  requirePermission(ctx, "purchases.create");
  const w = await warehouseAccess(ctx, input.warehouse_id);
  await one(
    ctx,
    "SELECT id FROM suppliers WHERE company_id=$1 AND id=$2 AND active",
    [ctx.companyId, input.supplier_id],
  );
  uniqueIds(input.lines.map((l: any) => l.product_id));
  const id = randomUUID(),
    number = await nextNumber(ctx, "PO");
  await ctx.db.query(
    "INSERT INTO purchase_orders(id,company_id,branch_id,warehouse_id,supplier_id,number,expected_date,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      id,
      ctx.companyId,
      w.branch_id,
      w.id,
      input.supplier_id,
      number,
      input.expected_date ?? null,
      input.notes ?? null,
      ctx.actor.id,
    ],
  );
  for (const l of input.lines) {
    const p = await one(
      ctx,
      "SELECT p.kind,u.fractional FROM products p JOIN units u ON u.company_id=p.company_id AND u.id=p.unit_id WHERE p.company_id=$1 AND p.id=$2 AND p.active",
      [ctx.companyId, l.product_id],
    );
    if (p.kind === "bundle")
      fail(422, "BUNDLE_PURCHASE", "Purchase bundle components individually");
    if (!p.fractional && !D(l.quantity).isInteger())
      fail(
        422,
        "WHOLE_QUANTITY_REQUIRED",
        "Purchase quantity is in base units and must be whole",
      );
    await ctx.db.query(
      "INSERT INTO purchase_order_lines(company_id,order_id,product_id,quantity,unit_cost) VALUES($1,$2,$3,$4,$5)",
      [ctx.companyId, id, l.product_id, l.quantity, l.unit_cost],
    );
  }
  await audit(ctx, "create", "purchase_order", id, null, { number, ...input });
  return getPurchaseOrder(ctx, id);
}
export async function getPurchaseOrder(ctx: Context, id: string) {
  requirePermission(ctx, "purchases.read");
  const o = await one(
    ctx,
    "SELECT o.*,s.name AS supplier,w.name AS warehouse FROM purchase_orders o JOIN suppliers s ON s.company_id=o.company_id AND s.id=o.supplier_id JOIN warehouses w ON w.company_id=o.company_id AND w.id=o.warehouse_id WHERE o.company_id=$1 AND o.id=$2",
    [ctx.companyId, id],
  );
  branchAccess(ctx, o.branch_id);
  await warehouseAccess(ctx, o.warehouse_id);
  const lines = (
    await ctx.db.query(
      `SELECT l.*,p.name,p.sku,p.batch_tracked,p.serial_tracked,p.expiry_tracked,coalesce((SELECT sum(g.quantity) FROM goods_receipt_lines g WHERE g.company_id=l.company_id AND g.order_line_id=l.id),0)::text AS received FROM purchase_order_lines l JOIN products p ON p.company_id=l.company_id AND p.id=l.product_id WHERE l.company_id=$1 AND l.order_id=$2 ORDER BY l.id`,
      [ctx.companyId, id],
    )
  ).rows;
  return {
    ...o,
    lines,
    total: money(
      sum(lines.map((l) => D(l.quantity).times(l.unit_cost).toString())),
    ),
  };
}
export async function transitionPurchaseOrder(
  ctx: Context,
  id: string,
  status: string,
  reason: string,
) {
  requirePermission(
    ctx,
    status === "approved" ? "purchases.approve" : "purchases.create",
  );
  const o = await one(
    ctx,
    "SELECT * FROM purchase_orders WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, o.branch_id);
  await warehouseAccess(ctx, o.warehouse_id);
  try {
    assertTransition("purchase_order", o.status, status);
  } catch (e: any) {
    fail(409, "INVALID_STATE", e.message);
  }
  if (["approved", "rejected"].includes(status)) {
    requirePermission(ctx, "purchases.approve");
    const total = (
      await ctx.db.query(
        "SELECT sum(quantity*unit_cost)::text AS n FROM purchase_order_lines WHERE company_id=$1 AND order_id=$2",
        [ctx.companyId, id],
      )
    ).rows[0].n;
    await checkApproval(ctx, o.created_by, money(total), reason);
  }
  if (
    status === "cancelled" &&
    (
      await ctx.db.query(
        "SELECT 1 FROM goods_receipts WHERE company_id=$1 AND order_id=$2 LIMIT 1",
        [ctx.companyId, id],
      )
    ).rowCount
  )
    fail(
      409,
      "ORDER_HAS_RECEIPTS",
      "A received order cannot be cancelled; close remaining quantities instead",
    );
  await ctx.db.query(
    "UPDATE purchase_orders SET status=$1,approved_by=CASE WHEN $1='approved' THEN $2 ELSE approved_by END,approval_reason=$3 WHERE company_id=$4 AND id=$5",
    [status, ctx.actor.id, reason, ctx.companyId, id],
  );
  await audit(
    ctx,
    status,
    "purchase_order",
    id,
    { status: o.status },
    { status },
    reason,
  );
  return { id, status };
}
export async function receiveGoods(ctx: Context, input: any) {
  requirePermission(ctx, "purchases.receive");
  const order = await one(
    ctx,
    "SELECT * FROM purchase_orders WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, input.order_id],
  );
  if (order.status !== "approved")
    fail(
      409,
      "ORDER_NOT_APPROVED",
      "Only approved purchase orders can be received",
    );
  branchAccess(ctx, order.branch_id);
  await warehouseAccess(ctx, order.warehouse_id);
  const date = await accountingDate(ctx, input.accounting_date);
  uniqueIds(input.lines.map((l: any) => l.order_line_id));
  const company = await one(ctx, "SELECT settings FROM companies WHERE id=$1", [
    ctx.companyId,
  ]);
  const id = randomUUID(),
    number = await nextNumber(ctx, "GRN"),
    computed: any[] = [];
  let stock = D(0),
    services = D(0);
  for (const l of input.lines) {
    const line = await one(
      ctx,
      "SELECT l.*,p.name,p.kind FROM purchase_order_lines l JOIN products p ON p.company_id=l.company_id AND p.id=l.product_id WHERE l.company_id=$1 AND l.id=$2 AND l.order_id=$3 FOR UPDATE OF l",
      [ctx.companyId, l.order_line_id, order.id],
    );
    const received = (
      await ctx.db.query(
        "SELECT coalesce(sum(quantity),0)::text AS n FROM goods_receipt_lines WHERE company_id=$1 AND order_line_id=$2",
        [ctx.companyId, line.id],
      )
    ).rows[0].n;
    const cumulative = D(received).plus(l.quantity);
    if (cumulative.gt(line.quantity)) {
      requirePermission(ctx, "purchases.approve");
      if (!input.reason || input.reason.length < 5)
        fail(422, "REASON_REQUIRED", "Over-deliveries require a reason");
      const max = D(line.quantity).times(
        D(1).plus(D(company.settings.overDeliveryPercent ?? 0).div(100)),
      );
      if (cumulative.gt(max))
        fail(
          409,
          "OVER_DELIVERY",
          "Delivery exceeds the configured authorized tolerance",
        );
    }
    const value = money(D(l.quantity).times(line.unit_cost));
    computed.push({ ...l, line, value });
    if (line.kind === "stock") stock = stock.plus(value);
    else services = services.plus(value);
  }
  await lockStock(
    ctx,
    computed
      .filter((l) => l.line.kind === "stock")
      .map((l) => ({
        productId: l.line.product_id,
        warehouseId: order.warehouse_id,
      })),
  );
  await ctx.db.query(
    "INSERT INTO goods_receipts(id,company_id,branch_id,warehouse_id,supplier_id,order_id,number,value,reason,created_by,accounting_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      id,
      ctx.companyId,
      order.branch_id,
      order.warehouse_id,
      order.supplier_id,
      order.id,
      number,
      money(stock.plus(services)),
      input.reason ?? null,
      ctx.actor.id,
      date,
    ],
  );
  for (let i = 0; i < computed.length; i++) {
    const l = computed[i];
    let movement: any = null;
    if (l.line.kind === "stock")
      movement = await moveStock(ctx, {
        productId: l.line.product_id,
        warehouseId: order.warehouse_id,
        quantity: l.quantity,
        unitCost: l.line.unit_cost,
        type: "goods_received",
        sourceType: "goods_receipt",
        sourceId: id,
        lineKey: String(i),
        reason: `${number} · ${order.number}`,
        batchNumber: l.batch_number,
        expiryDate: l.expiry_date,
        serials: l.serials,
      });
    await ctx.db.query(
      "INSERT INTO goods_receipt_lines(company_id,receipt_id,order_line_id,product_id,quantity,rejected_quantity,unit_cost,value,batch_id,serials) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        ctx.companyId,
        id,
        l.line.id,
        l.line.product_id,
        l.quantity,
        l.rejected_quantity,
        l.line.unit_cost,
        l.value,
        movement?.batch_id ?? null,
        JSON.stringify(l.serials),
      ],
    );
  }
  const total = money(stock.plus(services));
  if (D(total).gt(0))
    await postJournal(ctx, {
      branchId: order.branch_id,
      date,
      sourceType: "goods_receipt",
      sourceId: id,
      description: `${number} · Goods received, not yet invoiced`,
      lines: [
        { account: "inventory", debit: money(stock) },
        { account: "expenses", debit: money(services) },
        { account: "grni", credit: total },
      ],
    });
  await audit(
    ctx,
    "post",
    "goods_receipt",
    id,
    null,
    { number, order_id: order.id, value: total },
    input.reason ?? null,
  );
  return getGoodsReceipt(ctx, id);
}
export async function getGoodsReceipt(ctx: Context, id: string) {
  requirePermission(ctx, "purchases.read");
  const r = await one(
    ctx,
    "SELECT g.*,s.name AS supplier,p.number AS order_number FROM goods_receipts g JOIN suppliers s ON s.company_id=g.company_id AND s.id=g.supplier_id JOIN purchase_orders p ON p.company_id=g.company_id AND p.id=g.order_id WHERE g.company_id=$1 AND g.id=$2",
    [ctx.companyId, id],
  );
  branchAccess(ctx, r.branch_id);
  await warehouseAccess(ctx, r.warehouse_id);
  const lines = (
    await ctx.db.query(
      "SELECT l.*,p.name,p.sku,p.tax_rule_id FROM goods_receipt_lines l JOIN products p ON p.company_id=l.company_id AND p.id=l.product_id WHERE l.company_id=$1 AND l.receipt_id=$2 ORDER BY l.id",
      [ctx.companyId, id],
    )
  ).rows;
  return { ...r, lines };
}
export async function recognizeSupplierInvoice(ctx: Context, input: any) {
  requirePermission(ctx, "purchases.create");
  const grn = await one(
    ctx,
    "SELECT * FROM goods_receipts WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, input.receipt_id],
  );
  branchAccess(ctx, grn.branch_id);
  await warehouseAccess(ctx, grn.warehouse_id);
  await one(
    ctx,
    "SELECT id FROM suppliers WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, grn.supplier_id],
  );
  const date = await accountingDate(ctx, input.accounting_date);
  if (input.due_date < date)
    fail(
      422,
      "DUE_DATE",
      "Invoice due date cannot be earlier than the accounting date",
    );
  uniqueIds(input.lines.map((l: any) => l.receipt_line_id));
  const actual = (
    await ctx.db.query(
      "SELECT id FROM goods_receipt_lines WHERE company_id=$1 AND receipt_id=$2",
      [ctx.companyId, grn.id],
    )
  ).rows;
  if (
    actual.length !== input.lines.length ||
    actual.some(
      (l) => !input.lines.some((x: any) => x.receipt_line_id === l.id),
    )
  )
    fail(
      422,
      "INVOICE_MATCH",
      "Invoice must match every line in the selected GRN exactly once",
    );
  const computed: any[] = [];
  let net = D(0),
    tax = D(0);
  for (const l of input.lines) {
    const rule = await one(
      ctx,
      "SELECT * FROM tax_rules WHERE company_id=$1 AND id=$2 AND active AND valid_from<=$3::date AND (valid_to IS NULL OR valid_to>=$3::date)",
      [ctx.companyId, l.tax_rule_id, date],
    );
    const lineTax = money(D(l.net).times(rule.rate).div(100));
    computed.push({ ...l, tax: lineTax, rate: rule.rate });
    net = net.plus(l.net);
    tax = tax.plus(lineTax);
  }
  const id = randomUUID(),
    number = await nextNumber(ctx, "BILL"),
    total = money(net.plus(tax));
  if (D(total).lte(0))
    fail(422, "ZERO_INVOICE", "Supplier invoice total must be positive");
  await ctx.db.query(
    "INSERT INTO supplier_invoices(id,company_id,branch_id,supplier_id,receipt_id,number,supplier_reference,subtotal,tax,total,accounting_date,due_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
    [
      id,
      ctx.companyId,
      grn.branch_id,
      grn.supplier_id,
      grn.id,
      number,
      input.supplier_reference,
      money(net),
      money(tax),
      total,
      date,
      input.due_date,
      ctx.actor.id,
    ],
  );
  for (const l of computed)
    await ctx.db.query(
      "INSERT INTO supplier_invoice_lines(company_id,invoice_id,receipt_line_id,net,tax,tax_rate) VALUES($1,$2,$3,$4,$5,$6)",
      [ctx.companyId, id, l.receipt_line_id, l.net, l.tax, l.rate],
    );
  const variance = net.minus(grn.value),
    lines: PostingLine[] = [
      { account: "grni", debit: grn.value },
      { account: "tax_input", debit: money(tax) },
      { account: "ap", credit: total, supplierId: grn.supplier_id },
    ];
  if (!variance.eq(0))
    lines.push({
      account: "purchase_variance",
      ...(variance.gt(0)
        ? { debit: money(variance) }
        : { credit: money(variance.abs()) }),
    });
  await postJournal(ctx, {
    branchId: grn.branch_id,
    date,
    sourceType: "supplier_invoice",
    sourceId: id,
    description: `${number} · ${input.supplier_reference}`,
    lines,
  });
  await audit(ctx, "post", "supplier_invoice", id, null, {
    number,
    total,
    receipt_id: grn.id,
    variance: money(variance),
  });
  return {
    id,
    number,
    total,
    subtotal: money(net),
    tax: money(tax),
    outstanding: total,
  };
}
export async function returnSupplierGoods(ctx: Context, input: any) {
  requirePermission(ctx, "purchases.create");
  requirePermission(ctx, "inventory.write");
  const date = await accountingDate(ctx, input.accounting_date);
  const hint = await one(
    ctx,
    "SELECT supplier_id,branch_id FROM supplier_invoices WHERE company_id=$1 AND id=$2",
    [ctx.companyId, input.invoice_id],
  );
  branchAccess(ctx, hint.branch_id);
  await one(
    ctx,
    "SELECT id FROM suppliers WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, hint.supplier_id],
  );
  const invoice = await invoiceOutstanding(ctx, input.invoice_id),
    grn = await one(
      ctx,
      "SELECT * FROM goods_receipts WHERE company_id=$1 AND id=$2",
      [ctx.companyId, invoice.receipt_id],
    );
  await warehouseAccess(ctx, grn.warehouse_id);
  uniqueIds(input.lines.map((l: any) => l.receipt_line_id));
  const computed: any[] = [];
  let net = D(0),
    tax = D(0),
    stockValue = D(0),
    serviceValue = D(0);
  for (const l of input.lines) {
    const line = await one(
      ctx,
      "SELECT g.*,i.net,i.tax,p.kind,p.serial_tracked FROM goods_receipt_lines g JOIN supplier_invoice_lines i ON i.company_id=g.company_id AND i.receipt_line_id=g.id AND i.invoice_id=$3 JOIN products p ON p.company_id=g.company_id AND p.id=g.product_id WHERE g.company_id=$1 AND g.id=$2 AND g.receipt_id=$4",
      [ctx.companyId, l.receipt_line_id, invoice.id, grn.id],
    );
    if (
      line.serial_tracked &&
      (l.serials ?? []).some((s: string) => !line.serials.includes(s))
    )
      fail(
        422,
        "SERIAL_MISMATCH",
        "Returned serials must belong to the original goods receipt",
      );
    const prev = (
      await ctx.db.query(
        "SELECT coalesce(sum(quantity),0)::text AS q,coalesce(sum(net),0)::text AS n,coalesce(sum(tax),0)::text AS t FROM supplier_return_lines WHERE company_id=$1 AND receipt_line_id=$2",
        [ctx.companyId, line.id],
      )
    ).rows[0];
    const cum = D(prev.q).plus(l.quantity);
    if (cum.gt(line.quantity))
      fail(
        409,
        "RETURN_EXCEEDS_RECEIPT",
        "Supplier return exceeds unreturned received quantity",
      );
    const n = money(
        D(line.net)
          .times(cum)
          .div(line.quantity)
          .toDecimalPlaces(2)
          .minus(prev.n),
      ),
      t = money(
        D(line.tax)
          .times(cum)
          .div(line.quantity)
          .toDecimalPlaces(2)
          .minus(prev.t),
      );
    computed.push({ ...l, line, net: n, tax: t });
    net = net.plus(n);
    tax = tax.plus(t);
  }
  await lockStock(
    ctx,
    computed
      .filter((l) => l.line.kind === "stock")
      .map((l) => ({
        productId: l.line.product_id,
        warehouseId: grn.warehouse_id,
      })),
  );
  const id = randomUUID(),
    number = await nextNumber(ctx, "SCN");
  await ctx.db.query(
    "INSERT INTO supplier_returns(id,company_id,invoice_id,number,total,tax,reason,created_by,accounting_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      id,
      ctx.companyId,
      invoice.id,
      number,
      money(net.plus(tax)),
      money(tax),
      input.reason,
      ctx.actor.id,
      date,
    ],
  );
  for (let i = 0; i < computed.length; i++) {
    const l = computed[i];
    if (l.line.kind === "stock") {
      const m = await moveStock(ctx, {
        productId: l.line.product_id,
        warehouseId: grn.warehouse_id,
        quantity: qty(D(l.quantity).neg()),
        type: "supplier_return",
        sourceType: "supplier_return",
        sourceId: id,
        lineKey: String(i),
        reason: input.reason,
        batchId: l.line.batch_id ?? undefined,
        serials: l.serials,
        allowExpired: true,
      });
      stockValue = stockValue.plus(D(m.value).abs());
    } else serviceValue = serviceValue.plus(l.net);
    await ctx.db.query(
      "INSERT INTO supplier_return_lines(company_id,return_id,receipt_line_id,quantity,net,tax) VALUES($1,$2,$3,$4,$5,$6)",
      [ctx.companyId, id, l.line.id, l.quantity, l.net, l.tax],
    );
  }
  const variance = net.minus(stockValue).minus(serviceValue),
    lines: PostingLine[] = [
      {
        account: "ap",
        debit: money(net.plus(tax)),
        supplierId: invoice.supplier_id,
      },
      { account: "inventory", credit: money(stockValue) },
      { account: "expenses", credit: money(serviceValue) },
      { account: "tax_input", credit: money(tax) },
    ];
  if (!variance.eq(0))
    lines.push({
      account: "purchase_variance",
      ...(variance.gt(0)
        ? { credit: money(variance) }
        : { debit: money(variance.abs()) }),
    });
  await postJournal(ctx, {
    branchId: invoice.branch_id,
    date,
    sourceType: "supplier_return",
    sourceId: id,
    description: `${number} · Supplier credit note`,
    lines,
  });
  await audit(
    ctx,
    "post",
    "supplier_return",
    id,
    null,
    { number, total: money(net.plus(tax)) },
    input.reason,
  );
  return { id, number, total: money(net.plus(tax)) };
}
export async function listPurchases(
  ctx: Context,
  kind: "orders" | "receipts" | "invoices",
  q: any,
) {
  requirePermission(ctx, "purchases.read");
  const { page, limit, offset } = pageArgs(q);
  const table =
    kind === "orders"
      ? "purchase_orders"
      : kind === "receipts"
        ? "goods_receipts"
        : "supplier_invoices";
  const extra =
    kind === "orders"
      ? `,(SELECT coalesce(sum(l.quantity*l.unit_cost),0)::text FROM purchase_order_lines l WHERE l.company_id=p.company_id AND l.order_id=p.id) AS total`
      : kind === "invoices"
        ? `,supplier_invoice_balance(p.company_id,p.id)::text AS outstanding`
        : "";
  const branches = q.branch_id ? [q.branch_id] : ctx.actor.branch_ids;
  if (q.branch_id) branchAccess(ctx, q.branch_id);
  const r = await ctx.db.query(
    `SELECT p.*,s.name AS supplier${extra},count(*) OVER()::int AS _count FROM ${table} p JOIN suppliers s ON s.company_id=p.company_id AND s.id=p.supplier_id WHERE p.company_id=$1 AND p.branch_id=ANY($2::uuid[]) AND (p.number ILIKE $3 OR s.name ILIKE $3) ORDER BY p.created_at DESC LIMIT $4 OFFSET $5`,
    [
      ctx.companyId,
      branches,
      `%${String(q.q ?? "").slice(0, 120)}%`,
      limit,
      offset,
    ],
  );
  return {
    items: r.rows.map(({ _count, ...r }) => r),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
  };
}
