import { fixture } from "./helper.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction, one, idempotent } from "../../apps/api/src/db.ts";
import {
  checkoutSchema,
  customerSchema,
  productSchema,
  routeSchema,
  routeShiftOpenSchema,
  stockInputSchema,
} from "@duka/shared";
import {
  createProduct,
  saveContact,
} from "../../apps/api/src/services/catalog.ts";
import { postStockDocument } from "../../apps/api/src/services/inventory.ts";
import { checkout, getSale } from "../../apps/api/src/services/sales.ts";
import { settleContact } from "../../apps/api/src/services/payments.ts";
import {
  closeRouteShift,
  deliverySheet,
  getRouteShift,
  listRouteShifts,
  listRoutes,
  loadingSheet,
  openRouteShift,
  routeLedger,
  saveRoute,
} from "../../apps/api/src/services/route-shifts.ts";
import { businessPdf } from "../../apps/api/src/services/documents.ts";

after(() => pool.end());

async function routeFixture() {
  const f = await fixture();
  return transaction(f.actor, async (ctx) => {
    await ctx.db.query(
      "UPDATE companies SET settings=settings||'{\"allowCredit\":true}'::jsonb WHERE id=$1",
      [f.companyId],
    );
    const unit = await one(
        ctx,
        "SELECT id FROM units WHERE company_id=$1 AND symbol='pc'",
        [f.companyId],
      ),
      tax = await one(
        ctx,
        "SELECT id FROM tax_rules WHERE company_id=$1 AND code='VAT16'",
        [f.companyId],
      );
    const product = await createProduct(
      ctx,
      productSchema.parse({
        name: "Van route soda 500ml",
        sku: "VR1",
        price: "58",
        purchase_cost: "30",
        unit_id: unit.id,
        tax_rule_id: tax.id,
      }),
    );
    const product2 = await createProduct(
      ctx,
      productSchema.parse({
        name: "Van route water 1L",
        sku: "VR2",
        price: "45",
        purchase_cost: "20",
        unit_id: unit.id,
        tax_rule_id: tax.id,
      }),
    );
    await postStockDocument(
      ctx,
      stockInputSchema.parse({
        type: "opening",
        warehouse_id: f.warehouseId,
        reason: "Verified opening stock for route tests",
        lines: [
          { product_id: product.id, quantity: "50", unit_cost: "30" },
          { product_id: product2.id, quantity: "40", unit_cost: "20" },
        ],
      }),
    );
    const cash = (
      await ctx.db.query(
        "SELECT * FROM payment_methods WHERE company_id=$1 AND kind='cash'",
        [f.companyId],
      )
    ).rows[0]!;
    const route = await saveRoute(
      ctx,
      routeSchema.parse({
        name: "Thika Road route",
        code: "RT01",
        register_id: f.registerId,
        salesperson_id: f.actor.id,
        notes: "Morning van loop",
      }),
    );
    const routeCustomer = await saveContact(
      ctx,
      "customer",
      customerSchema.parse({
        name: "Kikuyu Duka",
        code: "RT001",
        credit_limit: "5000",
        route_id: route.id,
      }),
    );
    const offRouteCustomer = await saveContact(
      ctx,
      "customer",
      customerSchema.parse({
        name: "CBD Mini Mart",
        code: "RT002",
        credit_limit: "5000",
      }),
    );
    assert.equal(routeCustomer.route_id, route.id);
    return {
      ...f,
      route,
      routeCustomer,
      offRouteCustomer,
      product,
      product2,
      cash,
    };
  });
}

function creditSale(registerId: string, customerId: string, lines: any[]) {
  return checkoutSchema.parse({
    register_id: registerId,
    customer_id: customerId,
    lines,
    payments: [],
    customer_credit: "0",
  });
}

test("route shift: guard enforces route customers, sheets and ledger are exact", async () => {
  const f = await routeFixture();

  // Route listing shows the till, salesperson and zero outstanding before sales.
  await transaction(f.actor, async (ctx) => {
    const routes = await listRoutes(ctx, {});
    assert.equal(routes.total, 1);
    assert.ok(routes.items[0].register);
    assert.ok(routes.items[0].salesperson);
    // Route shifts are ordinary open shifts tagged with the route.
    assert.equal(routes.items[0].open_shifts, 0);
  });

  // Open a route shift: the till stays locked by the open shift.
  await transaction(f.actor, async (ctx) => {
    const shift = await openRouteShift(
      ctx,
      routeShiftOpenSchema.parse({
        route_id: f.route.id,
        opening_float: "200",
      }),
    );
    assert.equal(shift.route_id, f.route.id);
    assert.equal(shift.route, "Thika Road route");
    assert.equal(shift.status, "open");
    // Idempotent: reopening while open returns the same shift.
    const again = openRouteShift;
    const second = await again(ctx, {
      route_id: f.route.id,
      opening_float: "200",
    });
    assert.equal(second.id, shift.id);
  });

  const [shift] = await transaction(f.actor, async (ctx) => [
    (await listRouteShifts(ctx, { route_id: f.route.id, status: "open" }))
      .items[0],
  ]);
  assert.ok(shift);

  await transaction(f.actor, async (ctx) => {
    // Off-route customer / walk-in: hard rejection.
    await assert.rejects(
      checkout(
        ctx,
        creditSale(f.registerId, f.offRouteCustomer.id, [
          { product_id: f.product.id, quantity: "1" },
        ]),
      ),
      (e: any) => e.code === "ROUTE_CUSTOMER_MISMATCH",
    );
    await assert.rejects(
      checkout(
        ctx,
        checkoutSchema.parse({
          register_id: f.registerId,
          lines: [{ product_id: f.product.id, quantity: "1" }],
          payments: [],
          customer_credit: "0",
        }),
      ),
      (e: any) => e.code === "ROUTE_CUSTOMER_MISMATCH",
    );
  });

  // Two credit invoices to the route customer: posted atomically, not paid at checkout.
  const [sale1, sale2] = await transaction(f.actor, async (ctx) => {
    const i1 = creditSale(f.registerId, f.routeCustomer.id, [
      { product_id: f.product.id, quantity: "4" },
      { product_id: f.product2.id, quantity: "2" },
    ]);
    const sale1 = await idempotent(ctx, "checkout", "route-inv-1", i1, () =>
      checkout(ctx, i1),
    );
    const i2 = creditSale(f.registerId, f.routeCustomer.id, [
      { product_id: f.product.id, quantity: "1" },
    ]);
    const sale2 = await idempotent(ctx, "checkout", "route-inv-2", i2, () =>
      checkout(ctx, i2),
    );
    return [sale1, sale2];
  });
  assert.equal(Number(f.product.price), 58);

  await transaction(f.actor, async (ctx) => {
    const detail = await getRouteShift(ctx, shift.id);
    assert.equal(detail.invoices.length, 2);
    assert.equal(detail.totals.invoiced, detail.totals.outstanding);
    assert.equal(detail.branch_id, f.branchId);
    const s1 = await getSale(ctx, sale1.id);
    const expected1 = f.product.price * 4 + f.product2.price * 2;
    assert.equal(Number(s1.outstanding), expected1);
  });

  // Sheets before close are available as data (prints are the close artefact,
  // data remains authoritative).
  await transaction(f.actor, async (ctx) => {
    const load = loadingSheet;
    const sheet = await load(ctx, shift.id);
    const line = sheet.lines.find((l: any) => l.sku === "VR1");
    const line2 = sheet.lines.find((l: any) => l.sku === "VR2");
    assert.equal(Number(line.quantity), 5); // 4 + 1 consolidated across both invoices
    assert.equal(Number(line2.quantity), 2);
    const delivery = await deliverySheet(ctx, shift.id);
    assert.equal(delivery.customers.length, 1);
    assert.equal(delivery.customers[0].customer, "Kikuyu Duka");
    assert.equal(delivery.customers[0].invoices.length, 2);
    assert.equal(delivery.totals.invoices, 2);
    // Printable document kinds render.
    const pdf = await businessPdf(ctx, "route-loading", shift.id);
    assert.ok(pdf.length > 500);
    const pdf2 = await businessPdf(ctx, "route-delivery", shift.id);
    assert.ok(pdf2.length > 500);
  });

  // Later payment clears the account: settle fully against both invoices.
  await transaction(f.actor, async (ctx) => {
    const total = f.product.price * 5 + f.product2.price * 2;
    await settleContact(ctx, "customer", {
      contact_id: f.routeCustomer.id,
      branch_id: f.branchId,
      shift_id: shift.id,
      payment: {
        method_id: f.cash.id,
        amount: String(total),
        reference: "ROUTE-SETTLE-1",
      },
      allocations: [
        {
          document_id: sale1.id,
          document_type: "invoice",
          amount: String(f.product.price * 4 + f.product2.price * 2),
        },
        {
          document_id: sale2.id,
          document_type: "invoice",
          amount: String(f.product.price),
        },
      ],
    });
  });

  await transaction(f.actor, async (ctx) => {
    const s1 = await getSale(ctx, sale1.id);
    const s2 = await getSale(ctx, sale2.id);
    assert.equal(s1.outstanding, "0.00");
    assert.equal(s2.outstanding, "0.00");
    const ledger = await routeLedger(ctx, f.route.id, {});
    const row = ledger.customers.find(
      (c: any) => c.customer_id === f.routeCustomer.id,
    );
    assert.ok(row);
    assert.equal(row.balance, "0.00");
    const detail = await getRouteShift(ctx, shift.id);
    assert.equal(detail.totals.outstanding, "0.00");
  });

  // Close composes the normal cashier close on the route shift.
  await transaction(f.actor, async (ctx) => {
    const closed = await closeRouteShift(ctx, shift.id, {
      counts: { [f.cash.id]: "200" },
    });
    assert.equal(closed.status, "submitted");
  });
  await transaction(f.actor, async (ctx) => {
    await assert.rejects(
      closeRouteShift(ctx, shift.id, { counts: { [f.cash.id]: "200" } }),
      (e: any) => e.code === "INVALID_STATE",
    );
    const again2 = await openRouteShift(ctx, {
      route_id: f.route.id,
      opening_float: "200",
    });
    assert.notEqual(again2.id, shift.id);
    assert.equal(again2.route_id, f.route.id);
  });
});

test("route-management guardrails: unknown register/salesperson rejected; routes are company-isolated", async () => {
  const f = await routeFixture();
  await transaction(f.actor, async (ctx) => {
    await assert.rejects(
      saveRoute(
        ctx,
        routeSchema.parse({
          name: "Broken route",
          code: "BRK",
          register_id: randomUUID(),
        }),
      ),
      (e: any) => e.code === "UNKNOWN_REGISTER",
    );
    await assert.rejects(
      saveRoute(
        ctx,
        routeSchema.parse({
          name: "Broken route 2",
          code: "BRK2",
          salesperson_id: randomUUID(),
        }),
      ),
      (e: any) => e.code === "UNKNOWN_SALESPERSON",
    );
    // Exclusive route customers: a second route cannot hijack the customer's route.
    const route2 = await saveRoute(
      ctx,
      routeSchema.parse({ name: "Nakuru route", code: "RT02" }),
    );
    const moved = await saveContact(
      ctx,
      "customer",
      customerSchema.parse({
        name: "Kikuyu Duka",
        code: "RT001",
        route_id: route2.id,
      }),
      f.routeCustomer.id,
    );
    assert.equal(moved.route_id, route2.id);
  });
});

test("route shift only locks its assigned till, other registers stay usable", async () => {
  const f = await routeFixture();
  const shift = await transaction(f.actor, async (ctx) =>
    openRouteShift(ctx, {
      route_id: f.route.id,
      opening_float: "100",
    }),
  );
  assert.ok(shift.route_id);
  const list = await transaction(f.actor, (ctx) => listRouteShifts(ctx, {}));
  assert.ok(list.items.every((s: any) => s.route_id === f.route.id));
});
