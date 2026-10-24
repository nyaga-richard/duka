import type { z } from "zod";
import {
  D,
  money,
  qty,
  calculateLine,
  productSchema,
  customerSchema,
  supplierSchema,
  type CheckoutInput,
} from "@duka/shared";
import {
  one,
  fail,
  requirePermission,
  redactCosts,
  has,
  audit,
  type Context,
  pageArgs,
} from "../db.ts";
import {
  requireCustomerInScope,
  routeScope,
  scopeCustomerRouteAssignment,
} from "./route-scope.ts";
export async function createProduct(
  ctx: Context,
  input: z.infer<typeof productSchema>,
) {
  requirePermission(ctx, "catalog.write");
  const data = { ...input, barcode: input.barcode || null };
  if (
    data.serial_tracked &&
    (
      await one(
        ctx,
        "SELECT fractional FROM units WHERE company_id=$1 AND id=$2",
        [ctx.companyId, data.unit_id],
      )
    ).fractional
  )
    fail(422, "SERIAL_UNIT", "Serial-tracked products require whole units");
  if (data.parent_id) {
    const p = await one(
      ctx,
      "SELECT parent_id FROM products WHERE company_id=$1 AND id=$2",
      [ctx.companyId, data.parent_id],
    );
    if (p.parent_id)
      fail(422, "VARIANT_DEPTH", "Variants cannot have nested variants");
  }
  const keys = Object.keys(data),
    values = Object.values(data);
  const p = (
    await ctx.db.query(
      `INSERT INTO products(company_id,${keys.join(",")}) VALUES($1,${values.map((_, i) => "$" + (i + 2)).join(",")}) RETURNING *`,
      [ctx.companyId, ...values],
    )
  ).rows[0];
  if (p.barcode)
    await ctx.db.query(
      "INSERT INTO product_barcodes(company_id,product_id,barcode) VALUES($1,$2,$3)",
      [ctx.companyId, p.id, p.barcode],
    );
  await audit(ctx, "create", "product", p.id, null, p);
  return p;
}
export async function updateProduct(
  ctx: Context,
  id: string,
  input: z.infer<typeof productSchema>,
) {
  requirePermission(ctx, "catalog.write");
  const before = await one(
    ctx,
    "SELECT * FROM products WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  if (
    before.kind !== input.kind ||
    before.unit_id !== input.unit_id ||
    before.batch_tracked !== input.batch_tracked ||
    before.serial_tracked !== input.serial_tracked
  ) {
    const r = await ctx.db.query(
      "SELECT 1 FROM stock_movements WHERE company_id=$1 AND product_id=$2 LIMIT 1",
      [ctx.companyId, id],
    );
    if (r.rowCount)
      fail(
        409,
        "PRODUCT_HAS_HISTORY",
        "Cannot change inventory type, base unit or tracking after stock movements",
      );
  }
  const data = { ...input, barcode: input.barcode || null };
  const keys = Object.keys(data),
    vals = Object.values(data);
  const p = (
    await ctx.db.query(
      `UPDATE products SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(",")},updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *`,
      [ctx.companyId, id, ...vals],
    )
  ).rows[0];
  if (before.barcode !== data.barcode) {
    if (before.barcode)
      await ctx.db.query(
        "DELETE FROM product_barcodes WHERE company_id=$1 AND product_id=$2 AND barcode=$3",
        [ctx.companyId, id, before.barcode],
      );
    if (data.barcode)
      await ctx.db.query(
        "INSERT INTO product_barcodes(company_id,product_id,barcode) VALUES($1,$2,$3)",
        [ctx.companyId, id, data.barcode],
      );
  }
  await audit(ctx, "update", "product", id, before, p);
  return p;
}
export async function listProducts(ctx: Context, query: any) {
  requirePermission(ctx, "catalog.read");
  const { page, limit, offset } = pageArgs(query);
  const warehouse = query.warehouse_id ?? null;
  if (warehouse && !ctx.actor.warehouse_ids.includes(warehouse))
    fail(
      403,
      "WAREHOUSE_FORBIDDEN",
      "Warehouse not assigned within the selected branch",
    );
  const warehouseIds = warehouse ? [warehouse] : ctx.actor.warehouse_ids;
  const s = String(query.q ?? "")
    .trim()
    .slice(0, 160);
  const args: any[] = [
    ctx.companyId,
    warehouseIds,
    `%${s}%`,
    s,
    query.category_id ?? null,
    query.active === "all" ? null : true,
    limit,
    offset,
  ];
  const r = await ctx.db.query(
    `SELECT p.*,c.name AS category,u.symbol AS unit,u.fractional,t.rate AS tax_rate,t.kind AS tax_kind,
 coalesce(b.quantity,0)::text AS stock,coalesce(b.reserved,0)::text AS reserved,coalesce(b.value,0)::text AS stock_value,
 (SELECT a.id FROM attachments a WHERE a.company_id=p.company_id AND a.entity='product' AND a.record_id=p.id AND a.mime_type LIKE 'image/%' ORDER BY a.created_at LIMIT 1) AS image_attachment_id,
 CASE WHEN b.quantity>0 THEN b.value/b.quantity ELSE p.purchase_cost END::numeric(24,6)::text AS average_cost,count(*) OVER()::int AS _count
 FROM products p JOIN units u ON u.company_id=p.company_id AND u.id=p.unit_id JOIN tax_rules t ON t.company_id=p.company_id AND t.id=p.tax_rule_id
 LEFT JOIN categories c ON c.company_id=p.company_id AND c.id=p.category_id LEFT JOIN LATERAL (SELECT sum(sb.quantity) AS quantity,sum(sb.reserved) AS reserved,sum(sb.value) AS value FROM stock_balances sb WHERE sb.company_id=p.company_id AND sb.product_id=p.id AND sb.warehouse_id=ANY($2::uuid[])) b ON true
 WHERE p.company_id=$1 AND (p.name ILIKE $3 OR p.sku ILIKE $3 OR p.barcode=$4 OR c.name ILIKE $3 OR EXISTS(SELECT 1 FROM product_barcodes pb WHERE pb.company_id=p.company_id AND pb.product_id=p.id AND pb.barcode=$4))
 AND ($5::uuid IS NULL OR p.category_id=$5) AND ($6::boolean IS NULL OR p.active=$6)
 ORDER BY CASE WHEN p.barcode=$4 THEN 0 ELSE 1 END,p.name LIMIT $7 OFFSET $8`,
    args,
  );
  return {
    items: r.rows.map(({ _count, ...v }) => redactCosts(ctx, v)),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
  };
}
/** Atomically apply one or more retail price updates and record a queryable
 * change per product (sale documents always re-price from the product, so
 * prior sales are untouched; returns re-price from the original sale line). */
export async function changePrices(
  ctx: Context,
  input: { reason: string; prices: { product_id: string; price: string }[] },
) {
  requirePermission(ctx, "catalog.write");
  const ids = input.prices.map((p) => p.product_id);
  if (new Set(ids).size !== ids.length)
    fail(422, "DUPLICATE_PRODUCT", "Each product may appear once per change");
  const changed: any[] = [];
  for (const p of input.prices) {
    const next = D(p.price);
    if (next.isNegative())
      fail(422, "INVALID_PRICE", "Selling prices cannot be negative");
    const before = await one(
      ctx,
      "SELECT id,name,sku,price FROM products WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, p.product_id],
    );
    const row = (
      await ctx.db.query(
        "UPDATE products SET price=$1,updated_at=now() WHERE company_id=$2 AND id=$3 RETURNING *",
        [money(next), ctx.companyId, p.product_id],
      )
    ).rows[0];
    const change = (
      await ctx.db.query(
        "INSERT INTO product_price_changes(company_id,product_id,old_price,new_price,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          ctx.companyId,
          p.product_id,
          before.price,
          money(next),
          input.reason,
          ctx.actor.id,
        ],
      )
    ).rows[0];
    await audit(
      ctx,
      "price.update",
      "product",
      p.product_id,
      {
        price: before.price,
      },
      { price: money(next), reason: input.reason },
    );
    changed.push({
      ...change,
      product: before.name,
      sku: before.sku,
      price: row.price,
    });
  }
  return { changed: changed.length, items: changed };
}

export async function priceChanges(ctx: Context, q: any) {
  requirePermission(ctx, "catalog.read");
  const { page, limit, offset } = pageArgs(q);
  const r = await ctx.db.query(
    `SELECT c.*,p.name AS product,p.sku,u.name AS actor,count(*) OVER()::int AS _count
     FROM product_price_changes c
     JOIN products p ON p.company_id=c.company_id AND p.id=c.product_id
     JOIN identities u ON u.company_id=c.company_id AND u.id=c.actor_id
     WHERE c.company_id=$1
       AND ($2::uuid IS NULL OR c.product_id=$2)
       AND ($3::date IS NULL OR c.created_at >= $3::date)
       AND ($4::date IS NULL OR c.created_at < $4::date + interval '1 day')
       AND ($5::text IS NULL OR p.name ILIKE $5 OR p.sku ILIKE $5)
     ORDER BY c.created_at DESC,c.id LIMIT $6 OFFSET $7`,
    [
      ctx.companyId,
      q.product_id ?? null,
      q.from ?? null,
      q.to ?? null,
      q.q ? `%${String(q.q).trim().slice(0, 160)}%` : null,
      limit,
      offset,
    ],
  );
  return {
    items: r.rows.map(({ _count, ...v }) => v),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
  };
}
export async function saveContact(
  ctx: Context,
  kind: "customer" | "supplier",
  input: z.infer<typeof customerSchema> | z.infer<typeof supplierSchema>,
  id?: string,
) {
  requirePermission(
    ctx,
    kind === "customer" ? "customers.write" : "suppliers.write",
  );
  const table = kind === "customer" ? "customers" : "suppliers";
  if (kind === "customer" && !id)
    await scopeCustomerRouteAssignment(ctx, input as any, undefined);
  const keys = Object.keys(input),
    values = Object.values(input);
  let before = null;
  let row: any;
  if (id) {
    before = await one(
      ctx,
      `SELECT * FROM ${table} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
      [ctx.companyId, id],
    );
    if (kind === "customer")
      await scopeCustomerRouteAssignment(ctx, input as any, before.route_id);
    row = (
      await ctx.db.query(
        `UPDATE ${table} SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(",")} WHERE company_id=$1 AND id=$2 RETURNING *`,
        [ctx.companyId, id, ...values],
      )
    ).rows[0];
  } else
    row = (
      await ctx.db.query(
        `INSERT INTO ${table}(company_id,${keys.join(",")}) VALUES($1,${values.map((_, i) => "$" + (i + 2)).join(",")}) RETURNING *`,
        [ctx.companyId, ...values],
      )
    ).rows[0];
  await audit(ctx, id ? "update" : "create", kind, row.id, before, row);
  return row;
}
export async function listContacts(
  ctx: Context,
  kind: "customer" | "supplier",
  query: any,
) {
  requirePermission(
    ctx,
    kind === "customer" ? "customers.read" : "suppliers.read",
  );
  const { page, limit, offset } = pageArgs(query);
  const table = kind === "customer" ? "customers" : "suppliers",
    account = kind === "customer" ? "ar" : "ap";
  const scope = kind === "customer" ? await routeScope(ctx) : null;
  const r = await ctx.db.query(
    `SELECT c.*,coalesce((SELECT sum(${kind === "customer" ? "l.debit-l.credit" : "l.credit-l.debit"}) FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=c.company_id AND l.${kind}_id=c.id AND a.system_key=$2 AND j.branch_id=ANY($6::uuid[])),0)::text AS balance,count(*) OVER()::int AS _count FROM ${table} c WHERE c.company_id=$1 AND (c.name ILIKE $3 OR c.code ILIKE $3 OR c.phone ILIKE $3) AND ($7::uuid IS NULL OR c.route_id=$7)${kind === "customer" ? " AND ($8::uuid[] IS NULL OR c.route_id=ANY($8::uuid[]))" : ""} ORDER BY c.name LIMIT $4 OFFSET $5`,
    [
      ctx.companyId,
      account,
      `%${String(query.q ?? "").slice(0, 160)}%`,
      limit,
      offset,
      ctx.actor.branch_ids,
      kind === "customer" && query.route_id ? String(query.route_id) : null,
      ...(kind === "customer" ? [scope] : []),
    ],
  );
  return {
    items: r.rows.map(({ _count, ...v }) => v),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
  };
}
export async function priceCart(
  ctx: Context,
  input: Pick<
    CheckoutInput,
    | "lines"
    | "customer_id"
    | "price_list_id"
    | "discount_percent"
    | "override_reason"
  >,
  date: string,
) {
  const company = await one(ctx, "SELECT settings FROM companies WHERE id=$1", [
    ctx.companyId,
  ]);
  const customer = input.customer_id
    ? await one(
        ctx,
        "SELECT * FROM customers WHERE company_id=$1 AND id=$2 AND active",
        [ctx.companyId, input.customer_id],
      )
    : null;
  if (input.price_list_id)
    await one(
      ctx,
      "SELECT id FROM price_lists WHERE company_id=$1 AND id=$2 AND active",
      [ctx.companyId, input.price_list_id],
    );
  const txDiscount = D(input.discount_percent ?? 0);
  if (txDiscount.gt(0)) requirePermission(ctx, "sales.discount");
  const result: any[] = [];
  for (const line of input.lines) {
    const p = await one(
      ctx,
      `SELECT p.*,u.fractional,t.rate,t.kind AS tax_kind,t.valid_from,t.valid_to,t.active AS tax_active FROM products p JOIN units u ON u.company_id=p.company_id AND u.id=p.unit_id JOIN tax_rules t ON t.company_id=p.company_id AND t.id=p.tax_rule_id WHERE p.company_id=$1 AND p.id=$2 AND p.active`,
      [ctx.companyId, line.product_id],
    );
    const valid = (
      await ctx.db.query(
        "SELECT $1::date >= $2::date AND ($3::date IS NULL OR $1::date <=$3::date) AS ok",
        [date, p.valid_from, p.valid_to],
      )
    ).rows[0].ok;
    if (!valid || !p.tax_active)
      fail(
        409,
        "TAX_RULE_EXPIRED",
        `Tax rule for ${p.name} is not valid for this date`,
      );
    const unitId = line.unit_id ?? p.unit_id;
    let factor = "1";
    let fractional = p.fractional;
    if (unitId !== p.unit_id) {
      const conv = await one(
        ctx,
        "SELECT pu.factor,u.fractional FROM product_units pu JOIN units u ON u.company_id=pu.company_id AND u.id=pu.unit_id WHERE pu.company_id=$1 AND pu.product_id=$2 AND pu.unit_id=$3",
        [ctx.companyId, p.id, unitId],
      );
      factor = conv.factor;
      fractional = conv.fractional;
    }
    if (!fractional && !D(line.quantity).isInteger())
      fail(
        422,
        "WHOLE_QUANTITY_REQUIRED",
        `${p.name} does not allow fractional selling units`,
      );
    const baseQty = qty(D(line.quantity).times(factor));
    if (D(baseQty).eq(0))
      fail(422, "QUANTITY_PRECISION", "Quantity is below supported precision");
    const tier = (
      await ctx.db.query(
        "SELECT price FROM prices WHERE company_id=$1 AND product_id=$2 AND min_quantity<=$3 AND ((customer_id=$4 AND $4::uuid IS NOT NULL) OR (price_list_id=$5 AND $5::uuid IS NOT NULL)) ORDER BY (customer_id IS NOT NULL) DESC,min_quantity DESC LIMIT 1",
        [
          ctx.companyId,
          p.id,
          baseQty,
          input.customer_id ?? null,
          input.price_list_id ?? null,
        ],
      )
    ).rows[0];
    const normal = money(D(tier?.price ?? p.price).times(factor));
    const unitPrice = line.unit_price ?? normal;
    if (!D(unitPrice).eq(normal)) {
      requirePermission(ctx, "sales.price_override");
      if (!input.override_reason)
        fail(422, "REASON_REQUIRED", "A price override requires a reason");
    }
    if (D(unitPrice).lt(D(p.min_price).times(factor))) {
      requirePermission(ctx, "sales.price_override");
      if (!input.override_reason)
        fail(
          422,
          "REASON_REQUIRED",
          "Selling below the minimum price requires a reason",
        );
    }
    const manual = D(line.discount_percent ?? 0);
    if (manual.gt(0)) requirePermission(ctx, "sales.discount");
    const customerDisc = D(customer?.discount_percent ?? 0);
    const lineDisc = D(100).minus(
      D(100).minus(manual).times(D(100).minus(customerDisc)).div(100),
    );
    const effective = D(100).minus(
      D(100).minus(lineDisc).times(D(100).minus(txDiscount)).div(100),
    );
    if (effective.gt(company.settings.maxDiscountPercent ?? "10")) {
      requirePermission(ctx, "sales.price_override");
      if (!input.override_reason)
        fail(
          422,
          "REASON_REQUIRED",
          "An exceptional discount requires a reason",
        );
    }
    const calc = calculateLine({
      quantity: line.quantity,
      price: unitPrice,
      lineDiscount: lineDisc,
      transactionDiscount: txDiscount,
      taxRate: p.rate,
      inclusive: p.tax_inclusive,
    });
    result.push({
      ...line,
      ...calc,
      product: p,
      unit_id: unitId,
      unit_price: unitPrice,
      base_quantity: baseQty,
    });
  }
  return {
    lines: result,
    customer,
    subtotal: money(result.reduce((n, l) => n.plus(l.net), D(0))),
    tax: money(result.reduce((n, l) => n.plus(l.tax), D(0))),
    total: money(result.reduce((n, l) => n.plus(l.total), D(0))),
    discount: money(result.reduce((n, l) => n.plus(l.discount), D(0))),
  };
}
