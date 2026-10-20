import { D, money, sum } from "@duka/shared";
import {
  one,
  requirePermission,
  canReadCosts,
  has,
  fail,
  branchAccess,
  warehouseAccess,
  type Context,
  pageArgs,
} from "../db.ts";
export async function reportScope(ctx: Context, q: any) {
  const branches = q.branch_id ? [q.branch_id] : ctx.actor.branch_ids;
  if (q.branch_id) branchAccess(ctx, q.branch_id);
  const warehouses = q.warehouse_id
    ? [q.warehouse_id]
    : ctx.actor.warehouse_ids;
  if (q.warehouse_id && !ctx.actor.warehouse_ids.includes(q.warehouse_id))
    fail(403, "WAREHOUSE_FORBIDDEN", "Warehouse not assigned");
  ctx.businessToday ??= (
    await one(
      ctx,
      "SELECT to_char(now() AT TIME ZONE timezone,'YYYY-MM-DD') AS today FROM companies WHERE id=$1",
      [ctx.companyId],
    )
  ).today;
  const to = q.to ?? ctx.businessToday!,
    from = q.from ?? to.slice(0, 4) + "-01-01";
  if (from > to)
    fail(
      422,
      "REPORT_DATE_RANGE",
      "Report start date must not follow its end date",
    );
  return { branches, warehouses, from, to };
}
export async function trialBalance(ctx: Context, q: any) {
  requirePermission(ctx, "accounting.read");
  const s = await reportScope(ctx, q);
  const r = await ctx.db.query(
    `SELECT a.id,a.code,a.name,a.type,a.system_key,coalesce(sum(l.debit),0)::text AS debits,coalesce(sum(l.credit),0)::text AS credits,coalesce(sum(l.debit-l.credit),0)::text AS balance FROM accounts a LEFT JOIN (journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id AND j.accounting_date<=$2 AND j.branch_id=ANY($3::uuid[]) AND ($4::date IS NULL OR j.accounting_date>=$4)) ON l.company_id=a.company_id AND l.account_id=a.id WHERE a.company_id=$1 GROUP BY a.id ORDER BY a.code`,
    [ctx.companyId, s.to, s.branches, q.movements === "true" ? s.from : null],
  );
  const debit = sum(r.rows.map((r) => r.debits)),
    credit = sum(r.rows.map((r) => r.credits));
  return {
    items: r.rows,
    as_of: s.to,
    debits: money(debit),
    credits: money(credit),
    difference: money(debit.minus(credit)),
    balanced: debit.eq(credit),
  };
}
export async function profitAndLoss(ctx: Context, q: any) {
  requirePermission(ctx, "accounting.read");
  const t = await trialBalance(ctx, { ...q, movements: "true" });
  const income = t.items
    .filter((a) => a.type === "income")
    .map((a) => ({ ...a, amount: money(D(a.balance).neg()) }));
  const expenses = t.items
    .filter((a) => a.type === "expense")
    .map((a) => ({ ...a, amount: money(a.balance) }));
  const revenue = sum(income.map((a) => a.amount)),
    cost = sum(expenses.map((a) => a.amount));
  const cogs = sum(
    expenses.filter((a) => a.system_key === "cogs").map((a) => a.amount),
  );
  return {
    income,
    expenses,
    revenue: money(revenue),
    cogs: money(cogs),
    gross_profit: money(revenue.minus(cogs)),
    operating_expenses: money(cost.minus(cogs)),
    net_profit: money(revenue.minus(cost)),
    from: (await reportScope(ctx, q)).from,
    to: t.as_of,
  };
}
export async function balanceSheet(ctx: Context, q: any) {
  const t = await trialBalance(ctx, q);
  const assets = t.items
    .filter((a) => a.type === "asset")
    .map((a) => ({ ...a, amount: money(a.balance) }));
  const liabilities = t.items
    .filter((a) => a.type === "liability")
    .map((a) => ({ ...a, amount: money(D(a.balance).neg()) }));
  const equity = t.items
    .filter((a) => a.type === "equity")
    .map((a) => ({ ...a, amount: money(D(a.balance).neg()) }));
  const profit = sum(
    t.items
      .filter((a) => ["income", "expense"].includes(a.type))
      .map((a) => D(a.balance).neg().toString()),
  );
  const asset = sum(assets.map((a) => a.amount)),
    liab = sum(liabilities.map((a) => a.amount)),
    eq = sum(equity.map((a) => a.amount)).plus(profit);
  return {
    assets,
    liabilities,
    equity,
    current_earnings: money(profit),
    total_assets: money(asset),
    total_liabilities: money(liab),
    total_equity: money(eq),
    difference: money(asset.minus(liab).minus(eq)),
    balanced: asset.eq(liab.plus(eq)),
    as_of: t.as_of,
  };
}
export async function generalLedger(ctx: Context, q: any) {
  requirePermission(ctx, "accounting.read");
  const s = await reportScope(ctx, q),
    { page, limit, offset } = pageArgs(q);
  const opening = (
    await ctx.db.query(
      `SELECT coalesce(sum(l.debit-l.credit),0)::text AS n FROM journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=$1 AND j.branch_id=ANY($2::uuid[]) AND j.accounting_date<$3 AND ($4::uuid IS NULL OR l.account_id=$4) AND ($5::uuid IS NULL OR l.customer_id=$5) AND ($6::uuid IS NULL OR l.supplier_id=$6)`,
      [
        ctx.companyId,
        s.branches,
        s.from,
        q.account_id ?? null,
        q.customer_id ?? null,
        q.supplier_id ?? null,
      ],
    )
  ).rows[0].n;
  const r = await ctx.db.query(
    `SELECT l.*,j.number,j.accounting_date,j.description,j.source_type,j.source_id,j.branch_id,a.code,a.name AS account,a.type,(sum(l.debit-l.credit) OVER(ORDER BY j.accounting_date,j.created_at,j.id,l.id ROWS UNBOUNDED PRECEDING)+$9::numeric)::text AS running_balance,count(*) OVER()::int AS _count FROM journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND j.branch_id=ANY($2::uuid[]) AND j.accounting_date BETWEEN $3 AND $4 AND ($5::uuid IS NULL OR l.account_id=$5) AND ($6::uuid IS NULL OR l.customer_id=$6) AND ($7::uuid IS NULL OR l.supplier_id=$7) ORDER BY j.accounting_date,j.created_at,j.id,l.id LIMIT $8 OFFSET $10`,
    [
      ctx.companyId,
      s.branches,
      s.from,
      s.to,
      q.account_id ?? null,
      q.customer_id ?? null,
      q.supplier_id ?? null,
      limit,
      opening,
      offset,
    ],
  );
  return {
    items: r.rows.map(({ _count, ...l }) => l),
    opening: money(opening),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
  };
}
export async function aging(
  ctx: Context,
  kind: "customer" | "supplier",
  q: any,
) {
  requirePermission(ctx, "reports.read");
  const scope = await reportScope(ctx, q),
    { page, limit, offset } = pageArgs(q),
    customer = kind === "customer";
  const balance = customer
    ? `s.total-s.paid_at_sale-coalesce((SELECT sum(a.amount) FROM customer_allocations a WHERE a.company_id=s.company_id AND a.sale_id=s.id AND a.accounting_date<=$2::date),0)-coalesce((SELECT sum(r.credit_applied) FROM sale_returns r WHERE r.company_id=s.company_id AND r.sale_id=s.id AND r.accounting_date<=$2::date),0)`
    : `supplier_invoice_balance(s.company_id,s.id,$2::date)`;
  const r = await ctx.db.query(
    `WITH items AS MATERIALIZED(
 SELECT s.id,s.number,s.${customer ? "customer_id" : "supplier_id"} AS contact_id,c.name,s.accounting_date,s.due_date,s.total,(${balance}) AS outstanding,'invoice'::text AS document_type,NULL::date AS original_date FROM ${customer ? "sales" : "supplier_invoices"} s JOIN ${customer ? "customers" : "suppliers"} c ON c.company_id=s.company_id AND c.id=s.${customer ? "customer_id" : "supplier_id"} WHERE s.company_id=$1 AND s.accounting_date<=$2::date AND s.branch_id=ANY($3::uuid[]) AND ($4::uuid IS NULL OR s.${customer ? "customer_id" : "supplier_id"}=$4)
 UNION ALL SELECT i.id,b.number||' · '||i.reference,i.${customer ? "customer_id" : "supplier_id"},c.name,b.accounting_date,i.due_date,i.amount,opening_item_balance(i.company_id,i.id,$2::date),'opening',i.original_date FROM opening_items i JOIN opening_batches b ON b.company_id=i.company_id AND b.id=i.batch_id JOIN ${customer ? "customers" : "suppliers"} c ON c.company_id=i.company_id AND c.id=i.${customer ? "customer_id" : "supplier_id"} WHERE i.company_id=$1 AND i.kind=$5 AND i.direction='debt' AND b.status='posted' AND b.accounting_date<=$2::date AND b.branch_id=ANY($3::uuid[]) AND ($4::uuid IS NULL OR i.${customer ? "customer_id" : "supplier_id"}=$4))
 SELECT *,GREATEST(0,$2::date-due_date) AS days_overdue,CASE WHEN due_date>=$2::date THEN 'Current' WHEN $2::date-due_date<=30 THEN '1–30' WHEN $2::date-due_date<=60 THEN '31–60' WHEN $2::date-due_date<=90 THEN '61–90' ELSE '90+' END AS bucket,count(*) OVER()::int AS _count FROM items WHERE outstanding<>0 ORDER BY due_date,number,id LIMIT $6 OFFSET $7`,
    [
      ctx.companyId,
      scope.to,
      scope.branches,
      q.contact_id ?? null,
      kind,
      limit,
      offset,
    ],
  );
  return {
    items: r.rows.map(({ _count, ...row }) => row),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
    as_of: scope.to,
  };
}
export async function contactStatement(
  ctx: Context,
  kind: "customer" | "supplier",
  id: string,
  q: any,
) {
  requirePermission(
    ctx,
    kind === "customer" ? "customers.read" : "suppliers.read",
  );
  const contact = await one(
    ctx,
    `SELECT * FROM ${kind === "customer" ? "customers" : "suppliers"} WHERE company_id=$1 AND id=$2`,
    [ctx.companyId, id],
  );
  // Statement includes control and advance accounts, never the entire unrelated GL.
  const s = await reportScope(ctx, q),
    { page, limit, offset } = pageArgs(q);
  const keys =
    kind === "customer"
      ? ["ar", "customer_advances"]
      : ["ap", "supplier_advances"];
  const opening = (
    await ctx.db.query(
      `SELECT coalesce(sum(l.debit-l.credit),0)::text AS n FROM journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND l.${kind}_id=$2 AND a.system_key=ANY($3::text[]) AND j.branch_id=ANY($4::uuid[]) AND j.accounting_date<$5`,
      [ctx.companyId, id, keys, s.branches, s.from],
    )
  ).rows[0].n;
  const r = await ctx.db.query(
    `SELECT j.number,j.accounting_date,j.description,j.source_type,j.source_id,l.debit,l.credit,a.name AS account,(sum(l.debit-l.credit) OVER(ORDER BY j.accounting_date,j.created_at,j.id,l.id)+$7::numeric)::text AS balance,count(*) OVER()::int AS _count FROM journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND l.${kind}_id=$2 AND a.system_key=ANY($3::text[]) AND j.branch_id=ANY($4::uuid[]) AND j.accounting_date BETWEEN $5 AND $6 ORDER BY j.accounting_date,j.created_at,j.id,l.id LIMIT $8 OFFSET $9`,
    [ctx.companyId, id, keys, s.branches, s.from, s.to, opening, limit, offset],
  );
  return {
    contact,
    opening: money(opening),
    items: r.rows.map(({ _count, ...l }) => l),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
    convention:
      "debit-positive; customer advances and supplier liabilities appear negative",
  };
}
export async function cashFlow(ctx: Context, q: any) {
  requirePermission(ctx, "accounting.read");
  const s = await reportScope(ctx, q);
  const filter = `l.company_id=$1 AND j.branch_id=ANY($2::uuid[]) AND a.system_key IN ('cash','bank','mpesa','card')`;
  const opening = (
    await ctx.db.query(
      `SELECT coalesce(sum(l.debit-l.credit),0)::text AS n FROM journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE ${filter} AND j.accounting_date<$3`,
      [ctx.companyId, s.branches, s.from],
    )
  ).rows[0].n;
  const r = await ctx.db.query(
    `SELECT j.source_type,coalesce(sum(l.debit),0)::text AS inflows,coalesce(sum(l.credit),0)::text AS outflows,coalesce(sum(l.debit-l.credit),0)::text AS net FROM journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE ${filter} AND j.accounting_date BETWEEN $3 AND $4 GROUP BY j.source_type ORDER BY j.source_type`,
    [ctx.companyId, s.branches, s.from, s.to],
  );
  const movement = sum(r.rows.map((r) => r.net));
  return {
    items: r.rows,
    opening: money(opening),
    net_movement: money(movement),
    closing: money(D(opening).plus(movement)),
    from: s.from,
    to: s.to,
    note: "Ledger cash movement by source; manual journals require accountant classification for statutory cash-flow presentation.",
  };
}
export async function taxSummary(ctx: Context, q: any) {
  const t = await trialBalance(ctx, { ...q, movements: "true" });
  const input = t.items.find((a) => a.system_key === "tax_input"),
    output = t.items.find((a) => a.system_key === "tax_output");
  const s = await reportScope(ctx, q);
  const r = await ctx.db.query(
    `SELECT tax_kind,tax_rate,sum(net)::text AS taxable_base,sum(tax)::text AS output_tax FROM (SELECT l.tax_kind,l.tax_rate,l.net,l.tax FROM sale_lines l JOIN sales s ON s.company_id=l.company_id AND s.id=l.sale_id WHERE l.company_id=$1 AND s.branch_id=ANY($2::uuid[]) AND s.accounting_date BETWEEN $3 AND $4 UNION ALL SELECT l.tax_kind,l.tax_rate,-r.net,-r.tax FROM sale_return_lines r JOIN sale_returns sr ON sr.company_id=r.company_id AND sr.id=r.return_id JOIN sale_lines l ON l.company_id=r.company_id AND l.id=r.sale_line_id WHERE r.company_id=$1 AND sr.branch_id=ANY($2::uuid[]) AND sr.accounting_date BETWEEN $3 AND $4) x GROUP BY tax_kind,tax_rate ORDER BY tax_kind,tax_rate`,
    [ctx.companyId, s.branches, s.from, s.to],
  );
  const payable = D(output?.balance ?? 0).neg(),
    recoverable = D(input?.balance ?? 0);
  return {
    items: r.rows,
    input_tax: money(recoverable),
    output_tax: money(payable),
    net_tax: money(payable.minus(recoverable)),
    from: s.from,
    to: s.to,
    note: "Reconcile with certified fiscal submissions before filing; not a tax return.",
  };
}
export async function inventoryValuation(ctx: Context, q: any) {
  requirePermission(ctx, "reports.read");
  const s = await reportScope(ctx, q),
    { page, limit, offset } = pageArgs(q);
  const r = await ctx.db.query(
    `SELECT p.id,p.name,p.sku,w.name AS warehouse,m.warehouse_id,sum(m.quantity)::text AS quantity,sum(m.value)::text AS value,CASE WHEN sum(m.quantity)>0 THEN sum(m.value)/sum(m.quantity) ELSE 0 END::numeric(24,6)::text AS average_cost,count(*) OVER()::int AS _count FROM stock_movements m JOIN products p ON p.company_id=m.company_id AND p.id=m.product_id JOIN warehouses w ON w.company_id=m.company_id AND w.id=m.warehouse_id WHERE m.company_id=$1 AND m.warehouse_id=ANY($2::uuid[]) AND m.accounting_date<=$3 GROUP BY p.id,w.id,m.warehouse_id ORDER BY p.name,w.name LIMIT $4 OFFSET $5`,
    [ctx.companyId, s.warehouses, s.to, limit, offset],
  );
  return {
    items: r.rows.map(({ _count, ...r }) => r),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
    as_of: s.to,
    method: "Moving weighted average",
  };
}
export async function salesAnalysis(ctx: Context, q: any) {
  requirePermission(ctx, "reports.read");
  const s = await reportScope(ctx, q),
    { page, limit, offset } = pageArgs(q);
  const dim = q.group ?? "product";
  const columns: Record<string, { join: string; id: string; name: string }> = {
    product: {
      join: "JOIN products d ON d.company_id=l.company_id AND d.id=l.product_id",
      id: "d.id",
      name: "d.name",
    },
    category: {
      join: "JOIN products p ON p.company_id=l.company_id AND p.id=l.product_id LEFT JOIN categories d ON d.company_id=p.company_id AND d.id=p.category_id",
      id: "d.id",
      name: "coalesce(d.name,'Uncategorized')",
    },
    customer: {
      join: "LEFT JOIN customers d ON d.company_id=s.company_id AND d.id=s.customer_id",
      id: "d.id",
      name: "coalesce(d.name,'Walk-in customer')",
    },
    cashier: {
      join: "JOIN identities d ON d.company_id=s.company_id AND d.id=s.created_by",
      id: "d.id",
      name: "d.name",
    },
    branch: {
      join: "JOIN branches d ON d.company_id=s.company_id AND d.id=s.branch_id",
      id: "d.id",
      name: "d.name",
    },
  };
  const def = columns[dim];
  if (!def) fail(422, "REPORT_GROUP", "Unknown grouping");
  const r = await ctx.db.query(
    `WITH activity AS(SELECT l.product_id,l.quantity,l.net,l.tax,l.total,l.cost,s.customer_id,s.created_by,s.branch_id,l.company_id FROM sale_lines l JOIN sales s ON s.company_id=l.company_id AND s.id=l.sale_id WHERE l.company_id=$1 AND s.branch_id=ANY($2::uuid[]) AND s.accounting_date BETWEEN $3 AND $4 AND ($5::uuid IS NULL OR l.product_id=$5) AND ($6::uuid IS NULL OR s.customer_id=$6) AND ($7::uuid IS NULL OR s.created_by=$7) UNION ALL SELECT l.product_id,-r.quantity,-r.net,-r.tax,-(r.net+r.tax),-r.cost,s.customer_id,s.created_by,s.branch_id,r.company_id FROM sale_return_lines r JOIN sale_returns sr ON sr.company_id=r.company_id AND sr.id=r.return_id JOIN sale_lines l ON l.company_id=r.company_id AND l.id=r.sale_line_id JOIN sales s ON s.company_id=l.company_id AND s.id=l.sale_id WHERE r.company_id=$1 AND sr.branch_id=ANY($2::uuid[]) AND sr.accounting_date BETWEEN $3 AND $4 AND ($5::uuid IS NULL OR l.product_id=$5) AND ($6::uuid IS NULL OR s.customer_id=$6) AND ($7::uuid IS NULL OR s.created_by=$7)) SELECT ${def.id} AS id,${def.name} AS name,sum(l.quantity)::text AS quantity,sum(l.net)::text AS revenue,sum(l.tax)::text AS tax,sum(l.total)::text AS total,sum(l.cost)::text AS cost,sum(l.net-l.cost)::text AS gross_profit,count(*) OVER()::int AS _count FROM activity l JOIN LATERAL(SELECT l.customer_id,l.created_by,l.branch_id,l.company_id) s ON true ${def.join} GROUP BY ${def.id},${def.name} ORDER BY sum(l.net) DESC LIMIT $8 OFFSET $9`,
    [
      ctx.companyId,
      s.branches,
      s.from,
      s.to,
      q.product_id ?? null,
      q.customer_id ?? null,
      q.user_id ?? null,
      limit,
      offset,
    ],
  );
  return {
    items: r.rows.map(({ _count, ...r }) => r),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
    from: s.from,
    to: s.to,
    group: dim,
  };
}
export async function dashboard(ctx: Context, q: any) {
  requirePermission(ctx, "dashboard.read");
  const s = await reportScope(ctx, q);
  const [
    totals,
    trend,
    paymentMethods,
    recent,
    low,
    top,
    balances,
    expenses,
    orders,
    variances,
  ] = [
    await ctx.db.query(
      `SELECT count(*)::int AS transactions,coalesce(sum(total),0)::text AS sales,coalesce(sum(subtotal),0)::text AS revenue,coalesce(sum(subtotal-cost),0)::text AS gross_profit,coalesce(sum(total-paid_at_sale),0)::text AS credit_sales FROM sales WHERE company_id=$1 AND branch_id=ANY($2::uuid[]) AND accounting_date BETWEEN $3 AND $4`,
      [ctx.companyId, s.branches, s.from, s.to],
    ),
    await ctx.db.query(
      `SELECT accounting_date::text AS date,sum(total)::text AS total,count(*)::int AS count FROM sales WHERE company_id=$1 AND branch_id=ANY($2::uuid[]) AND accounting_date BETWEEN $3 AND $4 GROUP BY accounting_date ORDER BY accounting_date`,
      [ctx.companyId, s.branches, s.from, s.to],
    ),
    await ctx.db.query(
      `SELECT m.name,m.kind,sum(CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END)::text AS amount FROM payments p JOIN payment_methods m ON m.company_id=p.company_id AND m.id=p.method_id WHERE p.company_id=$1 AND p.branch_id=ANY($2::uuid[]) AND p.accounting_date BETWEEN $3 AND $4 AND NOT EXISTS(SELECT 1 FROM expense_voids v WHERE v.company_id=p.company_id AND v.payment_id=p.id) GROUP BY m.id ORDER BY sum(p.amount) DESC`,
      [ctx.companyId, s.branches, s.from, s.to],
    ),
    await ctx.db.query(
      `SELECT s.id,s.number,s.total,s.paid_at_sale,(s.total-s.paid_at_sale-coalesce((SELECT sum(amount) FROM customer_allocations ca WHERE ca.company_id=s.company_id AND ca.sale_id=s.id),0)-coalesce((SELECT sum(credit_applied) FROM sale_returns sr WHERE sr.company_id=s.company_id AND sr.sale_id=s.id),0))::text AS outstanding,s.created_at,c.name AS customer,u.name AS cashier FROM sales s LEFT JOIN customers c ON c.company_id=s.company_id AND c.id=s.customer_id JOIN identities u ON u.company_id=s.company_id AND u.id=s.created_by WHERE s.company_id=$1 AND s.branch_id=ANY($2::uuid[]) ORDER BY s.created_at DESC LIMIT 6`,
      [ctx.companyId, s.branches],
    ),
    await ctx.db.query(
      `SELECT p.id,p.name,p.sku,b.quantity::text AS stock,p.reorder_level,w.name AS warehouse FROM stock_balances b JOIN products p ON p.company_id=b.company_id AND p.id=b.product_id JOIN warehouses w ON w.company_id=b.company_id AND w.id=b.warehouse_id WHERE b.company_id=$1 AND b.warehouse_id=ANY($2::uuid[]) AND p.active AND b.quantity<=p.reorder_level ORDER BY b.quantity-p.reorder_level LIMIT 6`,
      [ctx.companyId, s.warehouses],
    ),
    await ctx.db.query(
      `SELECT p.id,p.name,p.sku,c.name AS category,sum(l.quantity)::text AS quantity,sum(l.net)::text AS revenue FROM sale_lines l JOIN sales s ON s.company_id=l.company_id AND s.id=l.sale_id JOIN products p ON p.company_id=l.company_id AND p.id=l.product_id LEFT JOIN categories c ON c.company_id=p.company_id AND c.id=p.category_id WHERE l.company_id=$1 AND s.branch_id=ANY($2::uuid[]) AND s.accounting_date BETWEEN $3 AND $4 GROUP BY p.id,c.name ORDER BY sum(l.net) DESC LIMIT 5`,
      [ctx.companyId, s.branches, s.from, s.to],
    ),
    await ctx.db.query(
      `SELECT a.system_key,coalesce(sum(l.debit-l.credit),0)::text AS balance FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=$1 AND j.branch_id=ANY($2::uuid[]) AND a.system_key IN ('ar','ap','inventory','cash','bank','mpesa','card') AND j.accounting_date<=$3 GROUP BY a.system_key`,
      [ctx.companyId, s.branches, s.to],
    ),
    await ctx.db.query(
      `SELECT coalesce(sum(CASE WHEN direction='out' THEN amount ELSE -amount END),0)::text AS total FROM payments WHERE company_id=$1 AND branch_id=ANY($2::uuid[]) AND source_type IN ('expense','expense_refund') AND accounting_date BETWEEN $3 AND $4 AND NOT EXISTS(SELECT 1 FROM expense_voids v WHERE v.company_id=payments.company_id AND v.payment_id=payments.id)`,
      [ctx.companyId, s.branches, s.from, s.to],
    ),
    await ctx.db.query(
      "SELECT count(*)::int AS n FROM purchase_orders WHERE company_id=$1 AND branch_id=ANY($2::uuid[]) AND status IN ('submitted','approved')",
      [ctx.companyId, s.branches],
    ),
    await ctx.db.query(
      "SELECT coalesce(sum(variance),0)::text AS n FROM shifts WHERE company_id=$1 AND branch_id=ANY($2::uuid[]) AND closed_at::date BETWEEN $3 AND $4",
      [ctx.companyId, s.branches, s.from, s.to],
    ),
  ];
  const returns = (
    await ctx.db.query(
      "SELECT coalesce(sum(total),0)::text AS total,coalesce(sum(total-tax-cost),0)::text AS profit,count(*)::int AS count FROM sale_returns WHERE company_id=$1 AND branch_id=ANY($2::uuid[]) AND accounting_date BETWEEN $3 AND $4",
      [ctx.companyId, s.branches, s.from, s.to],
    )
  ).rows[0];
  const b = Object.fromEntries(
    balances.rows.map((r) => [r.system_key, r.balance]),
  );
  const gross = totals.rows[0];
  return {
    period: { from: s.from, to: s.to },
    totals: {
      ...gross,
      sales: money(D(gross.sales).minus(returns.total)),
      gross_profit: canReadCosts(ctx)
        ? money(D(gross.gross_profit).minus(returns.profit))
        : null,
      returns: returns.total,
      return_count: returns.count,
      receivables: money(b.ar ?? 0),
      payables: ctx.actor.permissions.some((p) =>
        ["suppliers.read", "accounting.read"].includes(p),
      )
        ? money(D(b.ap ?? 0).neg())
        : null,
      stock_value: canReadCosts(ctx) ? money(b.inventory ?? 0) : null,
      cash: money(b.cash ?? 0),
      expenses: ctx.actor.permissions.some((p) =>
        ["expenses.read", "accounting.read"].includes(p),
      )
        ? expenses.rows[0].total
        : null,
      outstanding_orders: orders.rows[0].n,
      cashier_variance: ctx.actor.permissions.some((p) =>
        ["shifts.review", "shifts.manage"].includes(p),
      )
        ? variances.rows[0].n
        : null,
    },
    trend: trend.rows,
    payment_methods: paymentMethods.rows,
    recent_sales: recent.rows,
    low_stock: low.rows,
    top_products: top.rows,
  };
}
export function csv(data: Record<string, unknown>[]) {
  if (!data.length) return "\ufeffNo records\r\n";
  const keys = Object.keys(data[0]);
  const cell = (v: unknown) => {
    let s =
      v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return (
    "\ufeff" +
    [
      keys.map(cell).join(","),
      ...data.map((r) => keys.map((k) => cell(r[k])).join(",")),
    ].join("\r\n")
  );
}
