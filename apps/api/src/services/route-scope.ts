// Route-based visibility: a route salesperson (routes.shift without
// routes.manage) sees only their own route(s) and the customers assigned to
// those routes. Managers (routes.manage) stay unrestricted. Pure data-layer
// dependency: only db.ts, safe to import from any service.
import { fail, has, type Context } from "../db.ts";

/**
 * Returns the actor's assigned route ids when they are a route salesperson,
 * null when unrestricted (managers and non-route staff). An empty array means
 * the actor is a route salesperson with no assigned route: nothing in scope.
 */
export async function routeScope(ctx: Context): Promise<string[] | null> {
  if (!has(ctx, "routes.shift") || has(ctx, "routes.manage")) return null;
  const rows = (
    await ctx.db.query(
      "SELECT id FROM routes WHERE company_id=$1 AND salesperson_id=$2 AND active",
      [ctx.companyId, ctx.actor.id],
    )
  ).rows;
  return rows.map((r: any) => r.id);
}

/** 404 when the route is outside the actor's scope (excluding managers). */
export async function requireRouteInScope(
  ctx: Context,
  routeId: string | null | undefined,
) {
  const scope = await routeScope(ctx);
  if (!scope) return;
  if (!routeId || !scope.includes(routeId))
    fail(
      404,
      "ROUTE_OUT_OF_SCOPE",
      "You can only access your own assigned route",
    );
}

/** 404 when the customer is not assigned to one of the actor's routes. */
export async function requireCustomerInScope(ctx: Context, customerId: string) {
  const scope = await routeScope(ctx);
  if (!scope) return;
  const row = (
    await ctx.db.query(
      "SELECT route_id FROM customers WHERE company_id=$1 AND id=$2",
      [ctx.companyId, customerId],
    )
  ).rows[0];
  if (!row || !row.route_id || !scope.includes(row.route_id))
    fail(
      404,
      "CUSTOMER_OUT_OF_SCOPE",
      "You can only access customers on your assigned route",
    );
}

/** True when the customer id is within the actor's route scope (or unscopped). */
export async function customerInScope(ctx: Context, customerId: string | null) {
  const scope = await routeScope(ctx);
  if (!scope) return true;
  if (!customerId) return false;
  const row = (
    await ctx.db.query(
      "SELECT route_id FROM customers WHERE company_id=$1 AND id=$2",
      [ctx.companyId, customerId],
    )
  ).rows[0];
  return !!row && !!row.route_id && scope.includes(row.route_id);
}

/**
 * Validate/normalize the route_id being saved on a customer: scoped staff may
 * only assign customers to their own route; when they own exactly one route a
 * blank route assignment is auto-corrected to it. An explicit null clears the
 * route of an in-scope customer; creating a customer without a route when the
 * actor owns several routes 422s (target required). Returns input unchanged
 * for unrestricted actors and suppliers.
 */
export async function scopeCustomerRouteAssignment(
  ctx: Context,
  input: { route_id?: string | null },
  existingRouteId?: string | null,
) {
  const scope = await routeScope(ctx);
  if (!scope) return input;
  const target = input.route_id ?? null;
  if (existingRouteId && !scope.includes(existingRouteId))
    fail(
      404,
      "CUSTOMER_OUT_OF_SCOPE",
      "You can only access customers on your assigned route",
    );
  if (target && !scope.includes(target))
    fail(
      422,
      "ROUTE_CUSTOMER_MISMATCH",
      "Customers can only be assigned to your own route",
    );
  if (!target) {
    if (scope.length > 1 && existingRouteId === undefined)
      fail(
        422,
        "ROUTE_REQUIRED",
        "Choose which of your routes this customer belongs to",
      );
    if (scope.length === 1) input.route_id = scope[0];
  }
  return input;
}
