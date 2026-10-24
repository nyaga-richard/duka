// Route (van) sales: named routes, exclusive route customers, route-tagged
// shifts, and close-of-shift loading / delivery sheets with a route ledger.
import { D, money } from "@duka/shared";
import type { z } from "zod";
import type { routeSchema } from "@duka/shared";
import {
  one,
  fail,
  branchAccess,
  requirePermission,
  has,
  audit,
  pageArgs,
  type Context,
} from "../db.ts";
import { openShift, closeShift } from "./shifts.ts";
import { contactStatement } from "./reports.ts";

type RouteInput = z.infer<typeof routeSchema>;

export async function listRoutes(ctx: Context, q: any) {
  requirePermission(ctx, "routes.read");
  const { page, limit, offset } = pageArgs(q);
  const r = await ctx.db.query(
    `SELECT r.*, u.name AS salesperson, g.name AS register, w.name AS warehouse,
        (SELECT count(*) FROM customers c WHERE c.company_id=r.company_id AND c.route_id=r.id)::int AS customers,
        coalesce((SELECT sum(l.debit-l.credit) FROM journal_lines l
          JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id AND a.system_key='ar'
          JOIN customers c ON c.company_id=l.company_id AND c.id=l.customer_id AND c.route_id=r.id
          WHERE l.company_id=r.company_id),0)::text AS outstanding,
        (SELECT count(*) FROM shifts s WHERE s.company_id=r.company_id AND s.route_id=r.id AND s.status='open')::int AS open_shifts,
        count(*) OVER()::int AS _count
     FROM routes r
     LEFT JOIN identities u ON u.company_id=r.company_id AND u.id=r.salesperson_id
     LEFT JOIN registers g ON g.company_id=r.company_id AND g.id=r.register_id
     LEFT JOIN warehouses w ON w.company_id=g.company_id AND w.id=g.warehouse_id
     WHERE r.company_id=$1 AND (r.name ILIKE $2 OR r.code ILIKE $2)
     ORDER BY r.name LIMIT $3 OFFSET $4`,
    [ctx.companyId, `%${String(q.q ?? "").slice(0, 160)}%`, limit, offset],
  );
  return {
    items: r.rows.map(({ _count, ...v }) => v),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
  };
}

export async function getRoute(ctx: Context, id: string) {
  requirePermission(ctx, "routes.read");
  const r = await one(
    ctx,
    `SELECT r.*, u.name AS salesperson, u.id IS NOT NULL AS has_salesperson,
        g.name AS register, g.warehouse_id, w.name AS warehouse
     FROM routes r
     LEFT JOIN identities u ON u.company_id=r.company_id AND u.id=r.salesperson_id
     LEFT JOIN registers g ON g.company_id=r.company_id AND g.id=r.register_id
     LEFT JOIN warehouses w ON w.company_id=g.company_id AND w.id=g.warehouse_id
     WHERE r.company_id=$1 AND r.id=$2`,
    [ctx.companyId, id],
  );
  r.customers = (
    await ctx.db.query(
      `SELECT c.id, c.name, c.code, c.phone, c.credit_limit, c.credit_days, c.active
       FROM customers c WHERE c.company_id=$1 AND c.route_id=$2 ORDER BY c.name`,
      [ctx.companyId, id],
    )
  ).rows;
  return r;
}

export async function saveRoute(ctx: Context, input: RouteInput, id?: string) {
  requirePermission(ctx, "routes.manage");
  if (input.register_id)
    await one(ctx, "SELECT id FROM registers WHERE company_id=$1 AND id=$2", [
      ctx.companyId,
      input.register_id,
    ]).catch(() =>
      fail(422, "UNKNOWN_REGISTER", "Choose a register of this company"),
    );
  if (input.salesperson_id)
    await one(ctx, "SELECT id FROM identities WHERE company_id=$1 AND id=$2", [
      ctx.companyId,
      input.salesperson_id,
    ]).catch(() =>
      fail(422, "UNKNOWN_SALESPERSON", "Choose a staff member of this company"),
    );
  const keys = Object.keys(input),
    values = Object.values(input);
  let before = null,
    row: any;
  if (id) {
    before = await one(
      ctx,
      "SELECT * FROM routes WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, id],
    );
    row = (
      await ctx.db.query(
        `UPDATE routes SET ${keys
          .map((k, i) => `${k}=$${i + 3}`)
          .join(",")} WHERE company_id=$1 AND id=$2 RETURNING *`,
        [ctx.companyId, id, ...values],
      )
    ).rows[0];
  } else
    row = (
      await ctx.db.query(
        `INSERT INTO routes(company_id,${keys.join(",")}) VALUES($1,${keys
          .map((_, i) => "$" + (i + 2))
          .join(",")}) RETURNING *`,
        [ctx.companyId, ...values],
      )
    ).rows[0];
  await audit(ctx, id ? "update" : "create", "route", row.id, before, row);
  return row;
}

async function loadOpenRouteShift(ctx: Context, routeId: string) {
  const shift = (
    await ctx.db.query(
      `SELECT * FROM shifts WHERE company_id=$1 AND route_id=$2 AND status IN ('open') FOR UPDATE`,
      [ctx.companyId, routeId],
    )
  ).rows[0];
  return shift ?? null;
}

export async function openRouteShift(
  ctx: Context,
  input: { route_id: string; opening_float: string },
) {
  requirePermission(ctx, "routes.shift");
  const route = await one(
    ctx,
    `SELECT * FROM routes WHERE company_id=$1 AND id=$2 AND active FOR UPDATE`,
    [ctx.companyId, input.route_id],
  );
  if (!route.register_id)
    fail(
      422,
      "ROUTE_REGISTER_REQUIRED",
      "Assign a till register to this route before opening a shift",
    );
  if (
    route.salesperson_id &&
    route.salesperson_id !== ctx.actor.id &&
    !has(ctx, "routes.manage")
  )
    fail(
      403,
      "ROUTE_SALESPERSON",
      "Only the assigned salesperson can open this route's shift",
    );
  const existing = await loadOpenRouteShift(ctx, route.id);
  if (existing) return existing;
  const shift = await openShift(ctx, {
    register_id: route.register_id,
    opening_float: input.opening_float,
  });
  await ctx.db.query(
    "UPDATE shifts SET route_id=$3 WHERE company_id=$1 AND id=$2",
    [ctx.companyId, shift.id, route.id],
  );
  await audit(ctx, "open", "route_shift", shift.id, null, {
    route_id: route.id,
    opening_float: input.opening_float,
  });
  return { ...shift, route_id: route.id, route: route.name };
}

export async function listRouteShifts(ctx: Context, q: any) {
  requirePermission(ctx, "routes.read");
  const { page, limit, offset } = pageArgs(q);
  const r = await ctx.db.query(
    `SELECT s.*, r.name AS route, r.code AS route_code, g.name AS register, u.name AS salesperson,
        coalesce((SELECT sum(v.total) FROM sales v WHERE v.company_id=s.company_id AND v.shift_id=s.id),0)::text AS invoiced,
        (SELECT count(*) FROM sales v WHERE v.company_id=s.company_id AND v.shift_id=s.id)::int AS invoices,
        count(*) OVER()::int AS _count
     FROM shifts s
     JOIN routes r ON r.company_id=s.company_id AND r.id=s.route_id
     JOIN registers g ON g.company_id=s.company_id AND g.id=s.register_id
     JOIN identities u ON u.company_id=s.company_id AND u.id=s.cashier_id
     WHERE s.company_id=$1 AND s.route_id IS NOT NULL
       AND ($2::uuid IS NULL OR s.route_id=$2)
       AND ($3::text IS NULL OR s.status=$3)
     ORDER BY s.opened_at DESC LIMIT $4 OFFSET $5`,
    [ctx.companyId, q.route_id || null, q.status || null, limit, offset],
  );
  return {
    items: r.rows.map(({ _count, ...v }) => v),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
  };
}

export async function getRouteShift(ctx: Context, id: string) {
  requirePermission(ctx, "routes.read");
  const shift = await one(
    ctx,
    `SELECT s.*, r.name AS route, r.code AS route_code, g.name AS register, u.name AS salesperson
     FROM shifts s
     JOIN routes r ON r.company_id=s.company_id AND r.id=s.route_id
     JOIN registers g ON g.company_id=s.company_id AND g.id=s.register_id
     JOIN identities u ON u.company_id=s.company_id AND u.id=s.cashier_id
     WHERE s.company_id=$1 AND s.id=$2 AND s.route_id IS NOT NULL`,
    [ctx.companyId, id],
  );
  branchAccess(ctx, shift.branch_id);
  const invoices = (
    await ctx.db.query(
      `SELECT v.id, v.number, c.name AS customer, v.total, v.paid_at_sale,
          coalesce((SELECT sum(amount) FROM customer_allocations a WHERE a.company_id=v.company_id AND a.sale_id=v.id),0)::text AS allocated,
          coalesce((SELECT sum(credit_applied) FROM sale_returns rr WHERE rr.company_id=v.company_id AND rr.sale_id=v.id),0)::text AS credited,
          v.accounting_date, v.created_at, v.due_date
       FROM sales v LEFT JOIN customers c ON c.company_id=v.company_id AND c.id=v.customer_id
       WHERE v.company_id=$1 AND v.shift_id=$2 ORDER BY v.created_at`,
      [ctx.companyId, id],
    )
  ).rows.map((r: any) => ({
    ...r,
    outstanding: money(
      D(r.total).minus(r.paid_at_sale).minus(r.allocated).minus(r.credited),
    ),
  }));
  return {
    ...shift,
    invoices,
    totals: {
      invoiced: money(sumAmount(invoices.map((i) => i.total))),
      outstanding: money(sumAmount(invoices.map((i) => i.outstanding))),
    },
  };
}

function sumAmount(values: string[]) {
  return values.reduce((n, v) => D(n).plus(v), D(0)).toString();
}

export async function closeRouteShift(
  ctx: Context,
  id: string,
  input: {
    counts: Record<string, string>;
    denominations?: Record<string, number>;
  },
) {
  requirePermission(ctx, "routes.shift");
  const shift = await one(
    ctx,
    "SELECT s.*, r.salesperson_id AS route_salesperson FROM shifts s JOIN routes r ON r.company_id=s.company_id AND r.id=s.route_id WHERE s.company_id=$1 AND s.id=$2 AND s.route_id IS NOT NULL FOR UPDATE",
    [ctx.companyId, id],
  );
  if (shift.status !== "open")
    fail(409, "INVALID_STATE", "Only an open route shift can be closed");
  if (
    shift.route_salesperson &&
    shift.route_salesperson !== ctx.actor.id &&
    !has(ctx, "routes.manage")
  )
    fail(
      403,
      "ROUTE_SALESPERSON",
      "Only the assigned salesperson can close this route's shift",
    );
  const closed = await closeShift(ctx, id, input);
  await audit(ctx, "close", "route_shift", id, null, { counts: input.counts });
  return closed;
}

export async function loadingSheet(ctx: Context, shiftId: string) {
  requirePermission(ctx, "routes.read");
  const shift = await shiftWithRoute(ctx, shiftId);
  const rows = (
    await ctx.db.query(
      `SELECT p.name, p.sku, u.symbol AS unit,
          sum(l.base_quantity)::text AS quantity,
          sum(l.net)::text AS net,
          sum(l.tax)::text AS tax,
          sum(l.total)::text AS total
       FROM sale_lines l
       JOIN sales s ON s.company_id=l.company_id AND s.id=l.sale_id
       JOIN products p ON p.company_id=l.company_id AND p.id=l.product_id
       JOIN units u ON u.company_id=l.company_id AND u.id=l.unit_id
       WHERE s.company_id=$1 AND s.shift_id=$2
       GROUP BY p.name, p.sku, u.symbol ORDER BY p.name`,
      [ctx.companyId, shiftId],
    )
  ).rows;
  return {
    shift,
    lines: rows,
    totals: {
      quantity: money(sumAmount(rows.map((r: any) => r.quantity))),
      net: money(sumAmount(rows.map((r: any) => r.net))),
      tax: money(sumAmount(rows.map((r: any) => r.tax))),
      total: money(sumAmount(rows.map((r: any) => r.total))),
    },
  };
}

export async function deliverySheet(ctx: Context, shiftId: string) {
  requirePermission(ctx, "routes.read");
  const shift = await shiftWithRoute(ctx, shiftId);
  const detail = await getRouteShift(ctx, shiftId);
  const byCustomer = new Map<string, any>();
  for (const inv of detail.invoices) {
    const key = inv.customer ?? "Walk-in";
    const entry = byCustomer.get(key) ?? {
      customer: key,
      invoices: [],
      total: D(0),
      outstanding: D(0),
    };
    entry.invoices.push({
      number: inv.number,
      at: inv.created_at,
      total: inv.total,
      outstanding: inv.outstanding,
      due_date: inv.due_date,
    });
    entry.total = entry.total.plus(inv.total);
    entry.outstanding = entry.outstanding.plus(inv.outstanding);
    byCustomer.set(key, entry);
  }
  const customers = [...byCustomer.values()].map((c) => ({
    ...c,
    total: money(c.total),
    outstanding: money(c.outstanding),
  }));
  return {
    shift,
    customers,
    totals: {
      total: money(sumAmount(customers.map((c) => c.total))),
      outstanding: money(sumAmount(customers.map((c) => c.outstanding))),
      invoices: detail.invoices.length,
    },
  };
}

async function shiftWithRoute(ctx: Context, id: string) {
  const shift = await one(
    ctx,
    `SELECT s.*, r.name AS route, r.code AS route_code, u.name AS salesperson, g.name AS register, w.name AS warehouse
     FROM shifts s
     JOIN routes r ON r.company_id=s.company_id AND r.id=s.route_id
     JOIN identities u ON u.company_id=s.company_id AND u.id=s.cashier_id
     JOIN registers g ON g.company_id=s.company_id AND g.id=s.register_id
     JOIN warehouses w ON w.company_id=g.company_id AND w.id=g.warehouse_id
     WHERE s.company_id=$1 AND s.id=$2 AND s.route_id IS NOT NULL`,
    [ctx.companyId, id],
  );
  branchAccess(ctx, shift.branch_id);
  return shift;
}

/** Route ledger: per-customer running ledger across invoices and payments. */
export async function routeLedger(ctx: Context, routeId: string, q: any) {
  requirePermission(ctx, "routes.read");
  const route = await one(
    ctx,
    "SELECT * FROM routes WHERE company_id=$1 AND id=$2",
    [ctx.companyId, routeId],
  );
  const customers = (
    await ctx.db.query(
      `SELECT c.id, c.name, c.code, c.phone,
          coalesce((SELECT sum(l.debit-l.credit) FROM journal_lines l
            JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id AND a.system_key='ar'
            WHERE l.company_id=c.company_id AND l.customer_id=c.id),0)::text AS outstanding
       FROM customers c WHERE c.company_id=$1 AND c.route_id=$2 ORDER BY c.name`,
      [ctx.companyId, routeId],
    )
  ).rows;
  const from = q.from ?? null,
    to = q.to ?? null;
  const movements = [];
  for (const c of customers) {
    const st = await contactStatement(ctx, "customer", c.id, {
      from,
      to,
      limit: 500,
    });
    movements.push({
      customer_id: c.id,
      customer: c.name,
      balance: money(c.outstanding),
      items: st.items ?? [],
      closing: money(
        st.items.length ? st.items[st.items.length - 1].balance : st.opening,
      ),
    });
  }
  await audit(ctx, "read", "route_ledger", routeId, null, { from, to });
  return { route, customers: movements };
}
