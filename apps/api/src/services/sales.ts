import { D, money, qty, sum, type CheckoutInput } from "@duka/shared";
import { randomUUID } from "node:crypto";
import {
  one,
  fail,
  requirePermission,
  canReadCosts,
  redactCosts,
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
import { postJournal, type PostingLine } from "@duka/accounting";
import { lockStock, moveStock } from "@duka/inventory";
import { priceCart } from "./catalog.ts";
import { validateShift, recordPayment, saleOutstanding } from "./payments.ts";
import { createAdvance, consumeAdvance } from "./advances.ts";
import { enqueueFiscal } from "../integrations/fiscal.ts";
export async function checkout(ctx: Context, input: CheckoutInput) {
  requirePermission(ctx, "sales.create");
  const date = await accountingDate(ctx, input.accounting_date);
  const register = await one(
    ctx,
    "SELECT * FROM registers WHERE company_id=$1 AND id=$2 AND active",
    [ctx.companyId, input.register_id],
  );
  branchAccess(ctx, register.branch_id);
  await warehouseAccess(ctx, register.warehouse_id);
  const shift = await one(
    ctx,
    "SELECT * FROM shifts WHERE company_id=$1 AND register_id=$2 AND cashier_id=$3 AND status IN ('open','rejected') FOR UPDATE",
    [ctx.companyId, register.id, ctx.actor.id],
  );
  if (input.customer_id)
    await one(
      ctx,
      "SELECT id FROM customers WHERE company_id=$1 AND id=$2 AND active FOR UPDATE",
      [ctx.companyId, input.customer_id],
    );
  const priced = await priceCart(ctx, input, date);
  if (shift.route_id) {
    if (!priced.customer || priced.customer.route_id !== shift.route_id)
      fail(
        422,
        "ROUTE_CUSTOMER_MISMATCH",
        "A route shift sells only to customers assigned to its route",
      );
  }
  let order: any = null;
  if (input.order_id) {
    order = await one(
      ctx,
      "SELECT * FROM business_documents WHERE company_id=$1 AND id=$2 AND kind='sales_order' AND status='approved' FOR UPDATE",
      [ctx.companyId, input.order_id],
    );
    if (
      order.warehouse_id !== register.warehouse_id ||
      order.customer_id !== (input.customer_id ?? null)
    )
      fail(
        422,
        "ORDER_MISMATCH",
        "Order customer and warehouse must match checkout",
      );
    const ordered = new Map<string, string>();
    for (const l of order.lines)
      ordered.set(
        l.product_id,
        qty(D(ordered.get(l.product_id) ?? 0).plus(l.base_quantity)),
      );
    const sold = new Map<string, string>();
    for (const l of priced.lines)
      sold.set(
        l.product_id,
        qty(D(sold.get(l.product_id) ?? 0).plus(l.base_quantity)),
      );
    if (
      ordered.size !== sold.size ||
      [...ordered].some(([id, q]) => !D(q).eq(sold.get(id) ?? 0))
    )
      fail(
        422,
        "ORDER_LINES_MISMATCH",
        "Order conversion must fulfil the approved quantities",
      );
  }
  const company = await one(ctx, "SELECT settings FROM companies WHERE id=$1", [
    ctx.companyId,
  ]);
  if (
    company.settings.fiscalRequired &&
    (process.env.ETIMS_MODE ?? "disabled") === "disabled"
  )
    fail(
      503,
      "FISCAL_UNAVAILABLE",
      "Fiscalization is required but no certified adapter is configured",
    );
  const cashPaid = sum(input.payments.map((p) => p.amount));
  const creditUsed = D(input.customer_credit);
  if (creditUsed.gt(0)) {
    if (!input.customer_id)
      fail(422, "CUSTOMER_REQUIRED", "Select a customer to use account credit");
    const credit = (
      await ctx.db.query(
        "SELECT coalesce(sum(l.credit-l.debit),0)::text AS n FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=$1 AND l.customer_id=$2 AND a.system_key='customer_advances' AND j.branch_id=$3",
        [ctx.companyId, input.customer_id, register.branch_id],
      )
    ).rows[0].n;
    if (creditUsed.gt(credit))
      fail(
        409,
        "CUSTOMER_CREDIT_INSUFFICIENT",
        "Insufficient unapplied customer credit",
      );
  }
  const paid = cashPaid.plus(creditUsed);
  if (paid.gt(priced.total))
    fail(
      422,
      "OVERPAYMENT",
      "Applied tenders exceed the sale total; enter cash net of change",
    );
  const outstanding = D(priced.total).minus(paid);
  if (outstanding.gt(0)) {
    requirePermission(ctx, "sales.credit");
    if (!priced.customer || !company.settings.allowCredit)
      fail(
        422,
        "CREDIT_NOT_ALLOWED",
        "A registered customer and enabled credit policy are required",
      );
    const balance = (
      await ctx.db.query(
        "SELECT coalesce(sum(l.debit-l.credit),0)::text AS n FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND l.customer_id=$2 AND a.system_key='ar'",
        [ctx.companyId, priced.customer.id],
      )
    ).rows[0].n;
    if (D(balance).plus(outstanding).gt(priced.customer.credit_limit)) {
      requirePermission(ctx, "sales.credit_override");
      if (!input.override_reason)
        fail(
          422,
          "REASON_REQUIRED",
          "Exceeding a credit limit requires a reason",
        );
    }
  }
  const id = randomUUID(),
    number = await nextNumber(ctx, "INV");
  if (creditUsed.gt(0))
    await consumeAdvance(ctx, {
      kind: "customer",
      contactId: input.customer_id!,
      branchId: register.branch_id,
      targetType: "sale",
      targetId: id,
      amount: money(creditUsed),
      date,
    });
  const pairs: { productId: string; warehouseId: string }[] = [];
  for (const l of priced.lines) {
    l.components = [];
    if (l.product.kind === "bundle") {
      const components = (
        await ctx.db.query(
          "SELECT bc.*,p.kind,p.batch_tracked,p.serial_tracked FROM bundle_components bc JOIN products p ON p.company_id=bc.company_id AND p.id=bc.product_id WHERE bc.company_id=$1 AND bc.bundle_id=$2 ORDER BY bc.product_id",
          [ctx.companyId, l.product_id],
        )
      ).rows;
      if (!components.length)
        fail(422, "EMPTY_BUNDLE", "Configure bundle components before sale");
      for (const c of components) {
        if (c.kind !== "stock" || c.batch_tracked || c.serial_tracked)
          fail(
            422,
            "BUNDLE_TRACKING_UNSUPPORTED",
            "Bundle components must be untracked stock items",
          );
        l.components.push({
          product_id: c.product_id,
          quantity: qty(D(c.quantity).times(l.base_quantity)),
        });
        pairs.push({
          productId: c.product_id,
          warehouseId: register.warehouse_id,
        });
      }
    } else if (l.product.kind === "stock")
      pairs.push({
        productId: l.product_id,
        warehouseId: register.warehouse_id,
      });
  }
  await lockStock(ctx, pairs);
  if (order) {
    const reservations = (
      await ctx.db.query(
        "SELECT * FROM stock_reservations WHERE company_id=$1 AND document_id=$2 AND status='active' FOR UPDATE",
        [ctx.companyId, order.id],
      )
    ).rows;
    for (const r of reservations) {
      await ctx.db.query(
        "UPDATE stock_balances SET reserved=reserved-$1 WHERE company_id=$2 AND product_id=$3 AND warehouse_id=$4",
        [r.quantity, ctx.companyId, r.product_id, r.warehouse_id],
      );
      await ctx.db.query(
        "UPDATE stock_reservations SET status='consumed' WHERE company_id=$1 AND id=$2",
        [ctx.companyId, r.id],
      );
    }
  }
  let index = 0;
  for (const l of priced.lines) {
    l.cost = "0.00";
    if (l.product.kind === "stock") {
      const m = await moveStock(ctx, {
        productId: l.product_id,
        warehouseId: register.warehouse_id,
        quantity: qty(D(l.base_quantity).neg()),
        type: "sale",
        sourceType: "sale",
        sourceId: id,
        lineKey: String(index),
        reason: `Sale ${number}`,
        batchId: l.batch_id,
        serials: l.serials,
      });
      l.cost = money(D(m.value).abs());
      l.components = [
        {
          product_id: l.product_id,
          quantity: l.base_quantity,
          cost: l.cost,
          batch_id: m.batch_id,
          serials: l.serials,
        },
      ];
    } else if (l.product.kind === "bundle") {
      let k = 0;
      for (const c of l.components) {
        const m = await moveStock(ctx, {
          productId: c.product_id,
          warehouseId: register.warehouse_id,
          quantity: qty(D(c.quantity).neg()),
          type: "sale",
          sourceType: "sale",
          sourceId: id,
          lineKey: `${index}:${k++}`,
          reason: `Bundle sale ${number}`,
        });
        c.cost = money(D(m.value).abs());
        l.cost = money(D(l.cost).plus(c.cost));
      }
    }
    if (D(l.net).lt(l.cost)) {
      requirePermission(ctx, "sales.below_cost");
      if (!input.override_reason)
        fail(
          422,
          "REASON_REQUIRED",
          "Selling below inventory cost requires an override reason",
        );
    }
    index++;
  }
  const cost = money(sum(priced.lines.map((l) => l.cost)));
  const due = (
    await ctx.db.query("SELECT ($1::date+($2::int))::text AS d", [
      date,
      priced.customer?.credit_days ?? 0,
    ])
  ).rows[0].d;
  await ctx.db.query(
    "INSERT INTO sales(id,company_id,branch_id,warehouse_id,register_id,shift_id,number,customer_id,created_by,accounting_date,due_date,subtotal,tax,total,paid_at_sale,cost,discount,notes,customer_credit_used) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
    [
      id,
      ctx.companyId,
      register.branch_id,
      register.warehouse_id,
      register.id,
      shift.id,
      number,
      input.customer_id ?? null,
      ctx.actor.id,
      date,
      due,
      priced.subtotal,
      priced.tax,
      priced.total,
      money(paid),
      cost,
      priced.discount,
      input.notes ?? null,
      money(creditUsed),
    ],
  );
  for (const l of priced.lines)
    await ctx.db.query(
      "INSERT INTO sale_lines(company_id,sale_id,product_id,description,quantity,base_quantity,unit_id,unit_price,discount,tax_rate,tax_kind,net,tax,total,cost,batch_id,serials,components) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",
      [
        ctx.companyId,
        id,
        l.product_id,
        l.product.name,
        l.quantity,
        l.base_quantity,
        l.unit_id,
        l.unit_price,
        l.discount,
        l.product.rate,
        l.product.tax_kind,
        l.net,
        l.tax,
        l.total,
        l.cost,
        l.batch_id ?? null,
        JSON.stringify(l.serials),
        JSON.stringify(l.components),
      ],
    );
  const lines: PostingLine[] = [];
  for (const p of input.payments) {
    const payment = await recordPayment(ctx, p, {
      branchId: register.branch_id,
      shiftId: shift.id,
      sourceType: "sale",
      sourceId: id,
      direction: "in",
      date,
    });
    lines.push({ account: payment.account, byId: true, debit: payment.amount });
  }
  if (creditUsed.gt(0))
    lines.push({
      account: "customer_advances",
      debit: money(creditUsed),
      customerId: input.customer_id,
    });
  if (outstanding.gt(0))
    lines.push({
      account: "ar",
      debit: money(outstanding),
      customerId: input.customer_id,
    });
  lines.push(
    { account: "sales", credit: priced.subtotal },
    { account: "tax_output", credit: priced.tax },
    { account: "cogs", debit: cost },
    { account: "inventory", credit: cost },
  );
  if (D(priced.total).gt(0) || D(cost).gt(0))
    await postJournal(ctx, {
      branchId: register.branch_id,
      date,
      sourceType: "sale",
      sourceId: id,
      description: `${number} · POS sale`,
      lines,
    });
  await enqueueFiscal(ctx, "sale", id);
  if (order)
    await ctx.db.query(
      "UPDATE business_documents SET status='converted',sale_id=$1 WHERE company_id=$2 AND id=$3",
      [id, ctx.companyId, order.id],
    );
  await audit(
    ctx,
    "post",
    "sale",
    id,
    null,
    {
      number,
      total: priced.total,
      paid: money(paid),
      outstanding: money(outstanding),
      discount: priced.discount,
    },
    input.override_reason ?? null,
  );
  return {
    id,
    number,
    subtotal: priced.subtotal,
    tax: priced.tax,
    total: priced.total,
    paid: money(paid),
    outstanding: money(outstanding),
    ...(canReadCosts(ctx) ? { cost } : {}),
    shift_id: shift.id,
  };
}
export async function getSale(ctx: Context, id: string, reprint = false) {
  requirePermission(ctx, "sales.read");
  const s = await saleOutstanding(ctx, id);
  const lines = (
    await ctx.db.query(
      "SELECT l.*,u.symbol AS unit FROM sale_lines l JOIN units u ON u.company_id=l.company_id AND u.id=l.unit_id WHERE l.company_id=$1 AND l.sale_id=$2 ORDER BY l.id",
      [ctx.companyId, id],
    )
  ).rows;
  const payments = (
    await ctx.db.query(
      "SELECT p.*,m.name AS method FROM payments p JOIN payment_methods m ON m.company_id=p.company_id AND m.id=p.method_id WHERE p.company_id=$1 AND p.source_type='sale' AND p.source_id=$2 ORDER BY p.created_at",
      [ctx.companyId, id],
    )
  ).rows;
  const company = await one(ctx, "SELECT * FROM companies WHERE id=$1", [
    ctx.companyId,
  ]);
  const branch = await one(
    ctx,
    "SELECT * FROM branches WHERE company_id=$1 AND id=$2",
    [ctx.companyId, s.branch_id],
  );
  const fiscal = (
    await ctx.db.query(
      "SELECT status,fiscal_id,error FROM fiscal_submissions WHERE company_id=$1 AND source_type='sale' AND source_id=$2",
      [ctx.companyId, id],
    )
  ).rows[0];
  if (reprint) await audit(ctx, "reprint", "sale", id);
  return {
    ...redactCosts(ctx, s),
    lines: lines.map((l) => redactCosts(ctx, l)),
    payments,
    company,
    branch,
    fiscal,
  };
}
export async function listSales(ctx: Context, q: any) {
  requirePermission(ctx, "sales.read");
  const { page, limit, offset } = pageArgs(q);
  const branches = q.branch_id ? [q.branch_id] : ctx.actor.branch_ids;
  if (q.branch_id) branchAccess(ctx, q.branch_id);
  const r = await ctx.db.query(
    `SELECT s.*,c.name AS customer,u.name AS cashier,coalesce((SELECT sum(amount) FROM customer_allocations a WHERE a.company_id=s.company_id AND a.sale_id=s.id),0)::text AS allocated,coalesce((SELECT sum(credit_applied) FROM sale_returns a WHERE a.company_id=s.company_id AND a.sale_id=s.id),0)::text AS credited,count(*) OVER()::int AS _count FROM sales s LEFT JOIN customers c ON c.company_id=s.company_id AND c.id=s.customer_id JOIN identities u ON u.company_id=s.company_id AND u.id=s.created_by WHERE s.company_id=$1 AND s.branch_id=ANY($2::uuid[]) AND (s.number ILIKE $3 OR c.name ILIKE $3) AND ($4::date IS NULL OR s.accounting_date>=$4) AND ($5::date IS NULL OR s.accounting_date<=$5) ORDER BY s.created_at DESC LIMIT $6 OFFSET $7`,
    [
      ctx.companyId,
      branches,
      `%${String(q.q ?? "").slice(0, 120)}%`,
      q.from ?? null,
      q.to ?? null,
      limit,
      offset,
    ],
  );
  return {
    items: r.rows.map(({ _count, ...r }) => ({
      ...redactCosts(ctx, r),
      outstanding: money(
        D(r.total).minus(r.paid_at_sale).minus(r.allocated).minus(r.credited),
      ),
    })),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
  };
}
export async function returnSale(ctx: Context, input: any) {
  requirePermission(ctx, "sales.return");
  const date = await accountingDate(ctx, input.accounting_date);
  const hint = await one(
    ctx,
    "SELECT customer_id,branch_id FROM sales WHERE company_id=$1 AND id=$2",
    [ctx.companyId, input.sale_id],
  );
  branchAccess(ctx, hint.branch_id);
  if (input.shift_id) await validateShift(ctx, input.shift_id, hint.branch_id);
  if (hint.customer_id)
    await one(
      ctx,
      "SELECT id FROM customers WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, hint.customer_id],
    );
  const sale = await saleOutstanding(ctx, input.sale_id);
  await warehouseAccess(ctx, sale.warehouse_id);
  const fiscalPolicy = await one(
    ctx,
    "SELECT settings FROM companies WHERE id=$1",
    [ctx.companyId],
  );
  if (
    fiscalPolicy.settings.fiscalRequired &&
    (process.env.ETIMS_MODE ?? "disabled") === "disabled"
  )
    fail(
      503,
      "FISCAL_UNAVAILABLE",
      "Fiscal credit-note integration is required but no certified adapter is configured",
    );
  uniqueIds(input.lines.map((l: any) => l.sale_line_id));
  const id = randomUUID(),
    number = await nextNumber(ctx, "CRN"),
    computed: any[] = [];
  let total = D(0),
    tax = D(0),
    cost = D(0);
  const pairs: { productId: string; warehouseId: string }[] = [];
  for (const l of input.lines) {
    const original = await one(
      ctx,
      "SELECT * FROM sale_lines WHERE company_id=$1 AND id=$2 AND sale_id=$3",
      [ctx.companyId, l.sale_line_id, sale.id],
    );
    const unit = await one(
      ctx,
      "SELECT fractional FROM units WHERE company_id=$1 AND id=$2",
      [ctx.companyId, original.unit_id],
    );
    if (!unit.fractional && !D(l.quantity).isInteger())
      fail(
        422,
        "WHOLE_QUANTITY_REQUIRED",
        "The original selling unit does not allow fractional returns",
      );
    const prev = (
      await ctx.db.query(
        "SELECT coalesce(sum(quantity),0)::text AS quantity,coalesce(sum(net),0)::text AS net,coalesce(sum(tax),0)::text AS tax,coalesce(sum(cost),0)::text AS cost FROM sale_return_lines WHERE company_id=$1 AND sale_line_id=$2",
        [ctx.companyId, l.sale_line_id],
      )
    ).rows[0];
    const cumulative = D(prev.quantity).plus(l.quantity);
    if (cumulative.gt(original.quantity))
      fail(
        409,
        "RETURN_EXCEEDS_SALE",
        "Returned quantity exceeds original unreturned quantity",
      );
    const net = money(
      D(original.net)
        .times(cumulative)
        .div(original.quantity)
        .toDecimalPlaces(2)
        .minus(prev.net),
    );
    const lineTax = money(
      D(original.tax)
        .times(cumulative)
        .div(original.quantity)
        .toDecimalPlaces(2)
        .minus(prev.tax),
    );
    const comps = original.components.map((c: any) => {
      const q = qty(D(c.quantity).times(l.quantity).div(original.quantity));
      const val = money(
        D(c.cost)
          .times(cumulative)
          .div(original.quantity)
          .toDecimalPlaces(2)
          .minus(
            D(c.cost)
              .times(prev.quantity)
              .div(original.quantity)
              .toDecimalPlaces(2),
          ),
      );
      if (l.restock)
        pairs.push({ productId: c.product_id, warehouseId: sale.warehouse_id });
      return { ...c, return_quantity: q, return_value: val };
    });
    const lineCost = money(sum(comps.map((c: any) => c.return_value)));
    const c = {
      ...l,
      original,
      prev,
      net,
      tax: lineTax,
      cost: lineCost,
      components: comps,
    };
    computed.push(c);
    total = total.plus(net).plus(lineTax);
    tax = tax.plus(lineTax);
    cost = cost.plus(lineCost);
  }
  await lockStock(ctx, pairs);
  const creditApplied = D(sale.outstanding).gt(0)
    ? DecimalMin(sale.outstanding, total)
    : D(0);
  const refundable = total.minus(creditApplied);
  const advance = input.credit_to_account ? refundable : D(0);
  if (advance.gt(0) && !sale.customer_id)
    fail(
      422,
      "CUSTOMER_REQUIRED",
      "Account-credit returns require a registered customer",
    );
  const refund = sum(input.payments.map((p: any) => p.amount)),
    pending = D(input.pending_refund?.amount ?? 0);
  if (!refund.plus(pending).plus(advance).eq(refundable))
    fail(
      422,
      "REFUND_AMOUNT",
      "Confirmed refund, pending refund and account credit must equal the paid portion of this return",
      { required: money(refundable) },
    );
  if (refund.gt(0) || pending.gt(0)) requirePermission(ctx, "sales.refund");
  await ctx.db.query(
    "INSERT INTO sale_returns(id,company_id,sale_id,number,branch_id,total,tax,cost,refund,credit_applied,advance_credit,pending_refund,reason,created_by,accounting_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
    [
      id,
      ctx.companyId,
      sale.id,
      number,
      sale.branch_id,
      money(total),
      money(tax),
      money(cost),
      money(refund),
      money(creditApplied),
      money(advance),
      money(pending),
      input.reason,
      ctx.actor.id,
      date,
    ],
  );
  let n = 0,
    restocked = D(0),
    damaged = D(0);
  for (const l of computed) {
    await ctx.db.query(
      "INSERT INTO sale_return_lines(company_id,return_id,sale_line_id,quantity,net,tax,cost,restock) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        ctx.companyId,
        id,
        l.sale_line_id,
        l.quantity,
        l.net,
        l.tax,
        l.cost,
        l.restock,
      ],
    );
    for (const c of l.components) {
      if (l.restock) {
        const serials = (c.serials ?? []).slice(
          Number(D(c.quantity).times(l.prev.quantity).div(l.original.quantity)),
          Number(
            D(c.quantity)
              .times(D(l.prev.quantity).plus(l.quantity))
              .div(l.original.quantity),
          ),
        );
        await moveStock(ctx, {
          productId: c.product_id,
          warehouseId: sale.warehouse_id,
          quantity: c.return_quantity,
          unitCost: qty(D(c.return_value).div(c.return_quantity)),
          exactValue: c.return_value,
          type: "sale_return",
          sourceType: "sale_return",
          sourceId: id,
          lineKey: String(n++),
          reason: input.reason,
          batchId: c.batch_id ?? undefined,
          serials,
        });
        restocked = restocked.plus(c.return_value);
      } else damaged = damaged.plus(c.return_value);
    }
  }
  const lines: PostingLine[] = [
    { account: "sales_returns", debit: money(total.minus(tax)) },
    { account: "tax_output", debit: money(tax) },
    { account: "inventory", debit: money(restocked) },
    { account: "stock_loss", debit: money(damaged) },
    { account: "cogs", credit: money(cost) },
  ];
  if (advance.gt(0))
    await createAdvance(ctx, {
      kind: "customer",
      contactId: sale.customer_id,
      branchId: sale.branch_id,
      sourceType: "sale_return",
      sourceId: id,
      amount: money(advance),
      date,
    });
  if (creditApplied.gt(0))
    lines.push({
      account: "ar",
      credit: money(creditApplied),
      customerId: sale.customer_id,
    });
  if (advance.gt(0))
    lines.push({
      account: "customer_advances",
      credit: money(advance),
      customerId: sale.customer_id,
    });
  for (const p of input.payments) {
    const pay = await recordPayment(ctx, p, {
      branchId: sale.branch_id,
      shiftId: input.shift_id,
      sourceType: "sale_return",
      sourceId: id,
      direction: "out",
      date,
    });
    lines.push({ account: pay.account, byId: true, credit: pay.amount });
  }
  if (pending.gt(0)) {
    const method = await one(
      ctx,
      "SELECT * FROM payment_methods WHERE company_id=$1 AND id=$2 AND active",
      [ctx.companyId, input.pending_refund.method_id],
    );
    if (method.kind === "cash")
      fail(
        422,
        "CASH_REFUND_NOT_PENDING",
        "Cash refunds must be recorded as confirmed cash payments",
      );
    await ctx.db.query(
      "INSERT INTO refund_requests(company_id,return_id,method_id,amount,created_by) VALUES($1,$2,$3,$4,$5)",
      [ctx.companyId, id, method.id, money(pending), ctx.actor.id],
    );
    lines.push({
      account: "refund_payable",
      credit: money(pending),
      customerId: sale.customer_id,
    });
  }
  if (total.gt(0) || cost.gt(0))
    await postJournal(ctx, {
      branchId: sale.branch_id,
      date,
      sourceType: "sale_return",
      sourceId: id,
      description: `${number} · Return of ${sale.number}`,
      lines,
    });
  await enqueueFiscal(ctx, "sale_return", id);
  await audit(
    ctx,
    "post",
    "sale_return",
    id,
    null,
    {
      number,
      total: money(total),
      refund: money(refund),
      credit_applied: money(creditApplied),
      pending_refund: money(pending),
    },
    input.reason,
  );
  return {
    id,
    number,
    total: money(total),
    refund: money(refund),
    credit_applied: money(creditApplied),
    advance_credit: money(advance),
    pending_refund: money(pending),
  };
}
const DecimalMin = (a: string, b: ReturnType<typeof D>) =>
  D(a).lt(b) ? D(a) : b;
