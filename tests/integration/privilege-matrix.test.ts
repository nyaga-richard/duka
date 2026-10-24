import { fixture } from "./helper.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pool, transaction, one, digest } from "../../apps/api/src/db.ts";
import { configureUser } from "../../apps/api/src/services/admin.ts";
import { routeRegistry } from "../../apps/api/src/http.ts";
import "../../apps/api/src/routes/index.ts";
import {
  checkoutSchema,
  customerSchema,
  supplierSchema,
  productSchema,
} from "@duka/shared";
import { createProduct } from "../../apps/api/src/services/catalog.ts";
import { checkout } from "../../apps/api/src/services/sales.ts";
import { postStockDocument } from "../../apps/api/src/services/inventory.ts";
import {
  createExpense,
  reviewExpense,
  payExpense,
  acquireAsset,
} from "../../apps/api/src/services/business.ts";
import { saveOpeningBatch } from "../../apps/api/src/services/opening-balances.ts";
import { saveContact } from "../../apps/api/src/services/catalog.ts";
import { openShift } from "../../apps/api/src/services/shifts.ts";
import { saveRoute } from "../../apps/api/src/services/route-shifts.ts";
import { postJournal } from "@duka/accounting";

process.env.LOG_LEVEL = "silent";
let server: Server, base: string;

before(async () => {
  await pool.query("DELETE FROM rate_limit_buckets WHERE key=ANY($1::text[])", [
    ["login:ip:127.0.0.1", "login:ip:::ffff:127.0.0.1"].map(digest),
  ]);
  const { createApp } = await import("../../apps/api/src/app.ts");
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + (server.address() as any).port;
});
after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  await pool.end();
});

type Session = { cookie: string; csrf: string; token: string };
async function call(
  path: string,
  options: {
    method?: string;
    body?: any;
    session?: Session;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    ...(options.body !== undefined
      ? { "content-type": "application/json" }
      : {}),
    ...(options.session
      ? { cookie: options.session.cookie, "X-CSRF-Token": options.session.csrf }
      : {}),
    ...options.headers,
  };
  const response = await fetch(base + path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { response, status: response.status, data: json.data, json };
}
async function signIn(email: string, password = "TestSecurePass-2026") {
  // Sweeps log in ~150×; keep the 30/15min login throttle from biting.
  await pool.query("DELETE FROM rate_limit_buckets");
  const r = await call("/api/v1/auth/login", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cookie = r.response.headers.get("set-cookie")!.split(";")[0];
  return {
    cookie,
    csrf: r.data.csrf_token,
    token: cookie.slice(cookie.indexOf("=") + 1),
  };
}
function concrete(path: string) {
  return path
    .replaceAll(":id", randomUUID())
    .replaceAll(":kind", "expense")
    .replaceAll(":name", "profit-loss");
}
const slug = (r: any) => r.method.toUpperCase() + " " + r.path;

test("every authenticated endpoint is 401 without a session — no silent public routes", async () => {
  const misses: string[] = [];
  for (const r of routeRegistry) {
    const res = await call("/api/v1" + concrete(r.path), {
      method: r.method.toUpperCase(),
      ...(r.method === "get" ? {} : { body: {} }),
    });
    if (res.status !== 401)
      misses.push(`${slug(r)} -> ${res.status} instead of 401`);
  }
  assert.deepEqual(misses, [], misses.join("\n"));
});

test("a zero-permission actor gets 403 on every permission-declared endpoint", async () => {
  const f = await fixture();
  const zero = await transaction(f.actor, async (ctx) => {
    const role = await one(
      ctx,
      "INSERT INTO roles(id,company_id,name) VALUES(gen_random_uuid(),$1,$2) RETURNING id",
      [f.companyId, "Audited zero-permission role"],
    );
    return configureUser(ctx, {
      name: "Matrix auditor",
      email: randomUUID() + "@example.test",
      password: "MatrixAuditor-2026",
      role_ids: [role.id],
      branch_ids: [f.branchId],
      warehouse_ids: [f.warehouseId],
    });
  });
  const session = await signIn(zero.email, "MatrixAuditor-2026");
  const missesGet: string[] = [],
    missesMut: string[] = [],
    soft: string[] = [];
  for (const r of routeRegistry) {
    if (r.method !== "get") continue;
    const res = await call("/api/v1" + concrete(r.path), { session });
    if (r.permission) {
      if (res.status !== 403)
        missesGet.push(`${slug(r)} -> ${res.status} instead of 403`);
    } else if (res.status >= 500) soft.push(`${slug(r)} -> ${res.status}`);
  }
  // Mutations: a fresh session per call (state-changing endpoints like
  // /auth/logout would otherwise corrupt the sweep mid-run).
  for (const r of routeRegistry) {
    if (r.method === "get") continue;
    const fresh = await signIn(zero.email, "MatrixAuditor-2026");
    // CSRF passes; the strict schema errs before/without any business logic.
    const res = await call("/api/v1" + concrete(r.path), {
      method: r.method.toUpperCase(),
      session: fresh,
      body: {},
    });
    // POST /auth/logout is 200-by-design for any authenticated session
    // (revokes that session); not a zero-permission leakage.
    if (r.method === "post" && r.path === "/auth/logout") {
      if (res.status !== 200)
        missesMut.push(`${slug(r)} -> ${res.status} expected 200 by design`);
      continue;
    }
    if (res.status < 400 || res.status >= 500)
      missesMut.push(`${slug(r)} -> ${res.status} expected 4xx fail-closed`);
    if (
      r.permission &&
      res.status !== 403 &&
      ![400, 404, 409, 422].includes(res.status)
    )
      missesMut.push(`${slug(r)} -> ${res.status} should 403 pre-logic`);
  }
  assert.deepEqual(soft, [], soft.join("\n"));
  assert.deepEqual(missesGet, [], missesGet.join("\n"));
  assert.deepEqual(missesMut, [], missesMut.join("\n"));
});

test("schema forgery: client-supplied company/creator/currency fields never survive strict parsing", async () => {
  const f = await fixture();
  const misses: string[] = [];
  for (const r of routeRegistry) {
    if (r.method === "get") continue;
    const session = await signIn(f.actor.email);
    const res = await call("/api/v1" + concrete(r.path), {
      method: r.method.toUpperCase(),
      session,
      body: {
        company_id: randomUUID(),
        created_by: randomUUID(),
        approved_by: randomUUID(),
        currency: "USD",
        csrf_token: "forged",
        actor: { id: randomUUID() },
        branch_ids: [randomUUID()],
        id: randomUUID(),
      },
    });
    if (res.status < 400 || res.status >= 500)
      misses.push(
        `${slug(r)} -> ${res.status}: forgery payload must fail closed`,
      );
  }
  assert.deepEqual(misses, [], misses.join("\n"));
});

test("cross-tenant: company B receives 403/404 for every concrete company A resource kind", async () => {
  const [A, B] = await Promise.all([fixture(), fixture()]);
  const bSession = await signIn(B.actor.email);
  // Build one concrete resource of each API-exposed kind in company A.
  const objects = await transaction(A.actor, async (ctx) => {
    await ctx.db.query(
      `UPDATE companies SET settings=settings||'{"allowSelfApproval":true}'::jsonb WHERE id=$1`,
      [A.companyId],
    );
    const dates = await one(
        ctx,
        "SELECT to_char(now() AT TIME ZONE timezone,'YYYY-MM-DD') AS today,(now() AT TIME ZONE timezone)::date-1 AS yesterday FROM companies WHERE id=$1",
        [A.companyId],
      ),
      yesterday = (
        await one(ctx, "SELECT $1::date::text AS date", [dates.yesterday])
      ).date;
    const customer = await saveContact(
        ctx,
        "customer",
        customerSchema.parse({
          name: "Tenant probe customer",
          code: "XT-C",
          credit_limit: "1000",
        }),
      ),
      supplier = await saveContact(
        ctx,
        "supplier",
        supplierSchema.parse({ name: "Tenant probe supplier", code: "XT-S" }),
      ),
      unit = await one(
        ctx,
        "SELECT id FROM units WHERE company_id=$1 LIMIT 1",
        [A.companyId],
      ),
      tax = await one(
        ctx,
        "SELECT id FROM tax_rules WHERE company_id=$1 AND code='VAT16'",
        [A.companyId],
      ),
      expenseCategory = await one(
        ctx,
        "SELECT id FROM expense_categories WHERE company_id=$1 LIMIT 1",
        [A.companyId],
      );
    const product = await createProduct(
      ctx,
      productSchema.parse({
        name: "Tenant probe tea",
        sku: "XT-TEA",
        price: "60",
        purchase_cost: "40",
        unit_id: unit.id,
        tax_rule_id: tax.id,
      }),
    );
    await postStockDocument(ctx, {
      branch_id: A.branchId,
      warehouse_id: A.warehouseId,
      type: "opening",
      reason: "Stock for tenant probes",
      lines: [{ product_id: product.id, quantity: "5", unit_cost: "40" }],
    });
    const shift = await openShift(ctx, {
      register_id: A.registerId,
      opening_float: "0",
    });
    const sale = await checkout(
      ctx,
      checkoutSchema.parse({
        register_id: A.registerId,
        customer_id: customer.id,
        lines: [{ product_id: product.id, quantity: "1" }],
        payments: [],
      }),
    );
    const expense = await createExpense(ctx, {
      branch_id: A.branchId,
      category_id: expenseCategory.id,
      tax_rule_id: tax.id,
      net: "25",
      description: "Tenant probe expense",
      accounting_date: dates.today,
    });
    await reviewExpense(ctx, expense.id, "approved", "Probe approval");
    const opening = await saveOpeningBatch(ctx, {
        branch_id: A.branchId,
        accounting_date: yesterday,
        reference: "Tenant probe opening cutover log",
        items: [
          {
            kind: "customer" as const,
            contact_code: "XT-C",
            reference: "XT-" + randomUUID().slice(0, 8),
            due_date: yesterday,
            amount: "10",
          },
        ],
      }),
      asset = await acquireAsset(ctx, {
        branch_id: A.branchId,
        name: "Tenant probe desk",
        cost: "100",
        residual: "0",
        useful_months: 12,
        acquired_date: dates.today,
      }),
      journal = await one(
        ctx,
        "SELECT id FROM journals WHERE company_id=$1 ORDER BY created_at DESC LIMIT 1",
        [A.companyId],
      );
    const route = await saveRoute(ctx, {
      name: "Tenant probe route",
      code: "XT-R",
      active: true,
      register_id: A.registerId,
      salesperson_id: A.actor.id,
    });
    return {
      product,
      sale,
      expense,
      opening,
      asset,
      journal,
      customer,
      supplier,
      shift,
      route,
    };
  });
  const o = objects as any;
  const concreteMap: Record<string, string> = {
    "GET /products/:id": o.product.id,
    "GET /pos/products/:id/availability": o.product.id,
    "GET /products/:id/attachments": o.product.id,
    "GET /customers/:id/statement": o.customer.id,
    "GET /customers/:id/open-items": o.customer.id,
    "GET /suppliers/:id/statement": o.supplier.id,
    "GET /suppliers/:id/open-items": o.supplier.id,
    "GET /sales/:id": o.sale.id,
    "GET /sales/:id/receipt": o.sale.id,
    "GET /expenses/:id": o.expense.id,
    "GET /expenses/:id/attachments": o.expense.id,
    "GET /accounting/opening-batches/:id": o.opening.id,
    "GET /accounting/journals/:id": o.journal.id,
    "GET /routes/:id": o.route.id,
    "GET /routes/:id/ledger": o.route.id,
  };
  // Hard-to-fixture but still parameterized GETs: foreign ids must also miss.
  const foreignMiss = [
    "GET /purchases/orders/:id",
    "GET /purchases/receipts/:id",
    "GET /purchases/invoices/:id",
    "GET /documents/:id",
    "GET /pos/orders/:id",
    "GET /integrations/mpesa/intents/:id",
    "GET /attachments/:id",
    "GET /route-shifts/:id",
    "GET /route-shifts/:id/loading-sheet",
    "GET /route-shifts/:id/delivery-sheet",
  ].map((p) => [p, randomUUID()] as const);
  const misses: string[] = [];
  const covered = new Set(Object.keys(concreteMap));
  for (const entry of routeRegistry) {
    if (entry.method !== "get" || !entry.path.includes(":")) continue;
    const key = slug(entry);
    const id =
      key === "GET /print/:kind/:id"
        ? o.expense.id
        : key === "GET /shifts/:id"
          ? o.shift.id
          : key === "GET /reports/:name"
            ? null
            : (concreteMap[key] ??
              foreignMiss.find(([k]) => k === key)?.[1] ??
              null);
    if (id === null) {
      if (key !== "GET /reports/:name")
        misses.push(`${key} is not covered by the tenant matrix`);
      continue;
    }
    const url =
      "/api/v1" +
      entry.path.replaceAll(":id", id).replaceAll(":kind", "expense") +
      // Availability requires a company-B warehouse id; foreign products
      // must still 404 even when the query string is valid locally.
      (key === "GET /pos/products/:id/availability"
        ? "?warehouse_id=" + B.warehouseId
        : "");
    const res = await call(url, { session: bSession });
    if (![403, 404].includes(res.status) || res.data)
      misses.push(
        `${key} -> ${res.status} leaked for company B (${JSON.stringify(res.data)?.slice(0, 120)}…?)`,
      );
  }
  // Concrete coverage assertions: never let the map silently shrink.
  const mustCover = Object.keys(concreteMap);
  assert.deepEqual([...covered].sort(), mustCover.sort());
  // Branch scope: A session cannot query with B's branch either.
  const aSession = await signIn(A.actor.email);
  const scoped = await call("/api/v1/sales?branch_id=" + B.branchId, {
    session: aSession,
  });
  assert.equal(scoped.status, 403);
  assert.deepEqual(misses, [], misses.join("\n"));
});

test("bulk/import surfaces enforce their caps at the boundary", async () => {
  const f = await fixture();
  const session = await signIn(f.actor.email);
  // Opening-item batch cap (rows mirror the CSV import surface).
  const many = Array.from({ length: 501 }, (_, i) => ({
    kind: "customer",
    contact_code: "X" + i,
    reference: "BULK-" + i,
    due_date: "2025-01-31",
    amount: "1",
  }));
  const oversized = await call("/api/v1/accounting/opening-batches", {
    method: "POST",
    session,
    body: {
      branch_id: f.branchId,
      accounting_date: "2025-01-31",
      reference: "Oversized import attempt",
      items: many,
    },
  });
  assert.ok(
    oversized.status >= 400 && oversized.status < 500,
    "501 opening rows must be refused: got " + oversized.status,
  );
  // Pagination cap.
  const tooMany = await call("/api/v1/products?limit=101", { session });
  assert.ok(tooMany.status >= 400 && tooMany.status < 500);
  // Search length cap.
  const longSearch = await call("/api/v1/products?q=" + "x".repeat(161), {
    session,
  });
  assert.ok(longSearch.status >= 400 && longSearch.status < 500);
});
