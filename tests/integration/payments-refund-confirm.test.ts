import { fixture } from "./helper.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pool, transaction, one, digest } from "../../apps/api/src/db.ts";
import { configureUser } from "../../apps/api/src/services/admin.ts";
import {
  checkoutSchema,
  saleReturnSchema,
  productSchema,
} from "@duka/shared";
import { createProduct } from "../../apps/api/src/services/catalog.ts";
import { checkout, returnSale } from "../../apps/api/src/services/sales.ts";
import { postStockDocument } from "../../apps/api/src/services/inventory.ts";
import { openShift } from "../../apps/api/src/services/shifts.ts";

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
  options: { method?: string; body?: any; session?: Session } = {},
) {
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(options.method && options.method !== "GET"
      ? { "Idempotency-Key": randomUUID() }
      : {}),
    ...(options.session
      ? { cookie: options.session.cookie, "X-CSRF-Token": options.session.csrf }
      : {}),
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
  await pool.query("TRUNCATE rate_limit_buckets");
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

async function pendingRefund() {
  const f = await fixture();
  const built = await transaction(f.actor, async (ctx) => {
    const unit = await one(
        ctx,
        "SELECT id FROM units WHERE company_id=$1 LIMIT 1",
        [f.companyId],
      ),
      tax = await one(
        ctx,
        "SELECT id FROM tax_rules WHERE company_id=$1 AND code='ZERO'",
        [f.companyId],
      ),
      bank = await one(
        ctx,
        "SELECT * FROM payment_methods WHERE company_id=$1 AND kind='bank'",
        [f.companyId],
      );
    const product = await createProduct(
      ctx,
      productSchema.parse({
        name: "Refundable kettle",
        sku: "RF-" + randomUUID().slice(0, 6),
        price: "40",
        purchase_cost: "20",
        unit_id: unit.id,
        tax_rule_id: tax.id,
      }),
    );
    // ZERO-rated: gross equals net, so settled amounts stay exact.
    await postStockDocument(ctx, {
      branch_id: f.branchId,
      warehouse_id: f.warehouseId,
      type: "opening",
      reason: "Stock for refund probes",
      lines: [{ product_id: product.id, quantity: "4", unit_cost: "20" }],
    });
    const shift = await openShift(ctx, {
      register_id: f.registerId,
      opening_float: "0",
    });
    const sale = await checkout(
      ctx,
      checkoutSchema.parse({
        register_id: f.registerId,
        lines: [{ product_id: product.id, quantity: "2" }],
        payments: [
          { method_id: bank.id, amount: "80", reference: randomUUID() },
        ],
      }),
    );
    const saleLine = await one(
      ctx,
      "SELECT id FROM sale_lines WHERE company_id=$1 AND sale_id=$2 AND product_id IS NOT NULL LIMIT 1",
      [f.companyId, sale.id],
    );
    const returned = await returnSale(
      ctx,
      saleReturnSchema.parse({
        sale_id: sale.id,
        reason: "Bank tender returned to external settlement",
        pending_refund: { method_id: bank.id, amount: "40" },
        lines: [{ sale_line_id: saleLine.id, quantity: "1", restock: true }],
        payments: [],
        shift_id: shift.id,
      }),
    );
    void returned;
    const refund = await one(
      ctx,
      "SELECT * FROM refund_requests WHERE company_id=$1 ORDER BY created_at DESC LIMIT 1",
      [f.companyId],
    );
    return { refund, bank };
  });
  return { f, ...built };
}

function roleUser(f: any, perms: string[], email = randomUUID() + "@example.test") {
  return transaction(f.actor, async (ctx: any) => {
    const role = await one(
      ctx,
      "INSERT INTO roles(id,company_id,name) VALUES(gen_random_uuid(),$1,$2) RETURNING id",
      [f.companyId, "Refund probe " + perms.join("+") + " " + randomUUID()],
    );
    for (const p of perms)
      await ctx.db.query(
        "INSERT INTO role_permissions(company_id,role_id,permission) VALUES($1,$2,$3)",
        [f.companyId, role.id, p],
      );
    return configureUser(ctx, {
      name: "Refund probe user",
      email,
      password: "RefundProbe-2026",
      role_ids: [role.id],
      branch_ids: [f.branchId],
      warehouse_ids: [f.warehouseId],
    });
  });
}

test("refund settlement requires BOTH payments.pay and integrations.manage — partial holders are denied at the right layer", async () => {
  const { f, refund } = await pendingRefund();
  const payOnly = await roleUser(f, ["payments.pay"]),
    integrationsOnly = await roleUser(f, ["integrations.manage"]),
    paySession = await signIn(payOnly.email, "RefundProbe-2026"),
    intSession = await signIn(integrationsOnly.email, "RefundProbe-2026");
  const body = {
    provider_reference: "BANK-REF-" + randomUUID().slice(0, 8),
    reason: "Bank statement matched outward refund",
  };
  const payAttempt = await call("/api/v1/payments/refunds/" + refund.id + "/confirm", {
    method: "POST",
    session: paySession,
    body,
  });
  // payments.pay satisfies the route wrapper; the handler's service-level
  // integrations.manage requirement is what must deny this holder.
  assert.equal(payAttempt.status, 403);
  assert.equal(payAttempt.json.error.code, "FORBIDDEN");
  assert.match(payAttempt.json.error.message, /integrations\.manage/);
  const intAttempt = await call("/api/v1/payments/refunds/" + refund.id + "/confirm", {
    method: "POST",
    session: intSession,
    body,
  });
  assert.equal(intAttempt.status, 403);
  assert.match(intAttempt.json.error.message, /payments\.pay/);
  // The refund must remain pending after both denials.
  await transaction(f.actor, async (ctx) => {
    const row = await one(
      ctx,
      "SELECT status FROM refund_requests WHERE company_id=$1 AND id=$2",
      [f.companyId, refund.id],
    );
    assert.equal(row.status, "pending");
  });
});

test("a doubly authorized settlement clears refund_payable exactly once", async () => {
  const { f, refund, bank } = await pendingRefund();
  const owner = await signIn(f.actor.email);
  const reference = "BANK-REF-" + randomUUID().slice(0, 8);
  const confirmed = await call("/api/v1/payments/refunds/" + refund.id + "/confirm", {
    method: "POST",
    session: owner,
    body: {
      provider_reference: reference,
      reason: "Bank statement matched outward refund",
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(confirmed.data.status, "settled");
  await transaction(f.actor, async (ctx) => {
    const row = await one(
      ctx,
      "SELECT status,provider_reference FROM refund_requests WHERE company_id=$1 AND id=$2",
      [f.companyId, refund.id],
    );
    assert.equal(row.status, "settled");
    assert.equal(row.provider_reference, reference);
    const payment = await one(
      ctx,
      "SELECT amount,direction,method_id,source_type FROM payments WHERE company_id=$1 AND source_type='refund_settlement' AND source_id=$2",
      [f.companyId, refund.id],
    );
    assert.equal(payment.amount, "40.00");
    assert.equal(payment.direction, "out");
    assert.equal(payment.method_id, bank.id);
    const journal = await one(
      ctx,
      "SELECT j.id, (SELECT coalesce(sum(CASE WHEN l.debit>0 THEN l.debit END),0) FROM journal_lines l WHERE l.journal_id=j.id) AS debits, (SELECT coalesce(sum(CASE WHEN l.credit>0 THEN l.credit END),0) FROM journal_lines l WHERE l.journal_id=j.id) AS credits FROM journals j WHERE j.company_id=$1 AND j.source_type='refund_settlement' AND j.source_id=$2",
      [f.companyId, refund.id],
    );
    assert.equal(journal.debits, "40.00");
    assert.equal(journal.credits, "40.00");
    const payable = await one(
      ctx,
      "SELECT l.debit FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.journal_id=$1 AND a.system_key='refund_payable'",
      [(await one(ctx, "SELECT id FROM journals WHERE company_id=$1 AND source_type='refund_settlement' AND source_id=$2", [f.companyId, refund.id])).id],
    );
    assert.equal(payable.debit, "40.00");
    const methodLine = await one(
      ctx,
      "SELECT l.credit FROM journal_lines l WHERE l.journal_id=$1 AND l.account_id=$2",
      [
        (await one(ctx, "SELECT id FROM journals WHERE company_id=$1 AND source_type='refund_settlement' AND source_id=$2", [f.companyId, refund.id])).id,
        bank.account_id,
      ],
    );
    assert.equal(methodLine.credit, "40.00");
  });
  // Second settlement must be rejected — refunded money never leaves twice.
  const again = await call("/api/v1/payments/refunds/" + refund.id + "/confirm", {
    method: "POST",
    session: owner,
    body: {
      provider_reference: "BANK-REF-" + randomUUID().slice(0, 8),
      reason: "Duplicate settlement attempt",
    },
  });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "REFUND_ALREADY_SETTLED");
  await transaction(f.actor, async (ctx) => {
    const payments = await ctx.db.query(
      "SELECT count(*)::int AS n FROM payments WHERE company_id=$1 AND source_type='refund_settlement' AND source_id=$2",
      [f.companyId, refund.id],
    );
    assert.equal(payments.rows[0].n, 1);
  });
});

test("cross-tenant settlement is invisible: company B cannot settle company A's refund", async () => {
  const [mine, other] = await Promise.all([pendingRefund(), fixture()]);
  const otherSession = await signIn(other.actor.email);
  const attempt = await call("/api/v1/payments/refunds/" + mine.refund.id + "/confirm", {
    method: "POST",
    session: otherSession,
    body: {
      provider_reference: "BANK-REF-FORGN",
      reason: "Foreign settlement attempt",
    },
  });
  assert.ok([403, 404].includes(attempt.status));
  assert.equal(attempt.data, undefined);
  await transaction(mine.f.actor, async (ctx) => {
    const row = await one(
      ctx,
      "SELECT status FROM refund_requests WHERE company_id=$1 AND id=$2",
      [mine.f.companyId, mine.refund.id],
    );
    assert.equal(row.status, "pending");
  });
});

test("refund list is permission-gated, branch-scoped and tenant-isolated", async () => {
  const mine = await pendingRefund(),
    other = await fixture(),
    canSee = await roleUser(mine.f, ["sales.refund"]),
    canNotList = await roleUser(mine.f, ["payments.pay"]),
    seeSession = await signIn(canSee.email, "RefundProbe-2026"),
    denySession = await signIn(canNotList.email, "RefundProbe-2026"),
    otherSession = await signIn(other.actor.email);
  // Authorized holder sees the pending settlement with its context columns.
  const list = await call("/api/v1/payments/refunds", { session: seeSession });
  assert.equal(list.status, 200);
  const mineRow = list.json.data.items.find(
    (r: any) => r.id === mine.refund.id,
  );
  assert.ok(mineRow, "pending refund visible to a sales.refund holder");
  assert.equal(mineRow.status, "pending");
  assert.ok(mineRow.credit_note, "return credit note number joined");
  assert.ok(mineRow.method, "payment method name joined");
  // payments.pay alone does NOT authorize the settlement queue.
  const denied = await call("/api/v1/payments/refunds", {
    session: denySession,
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "FORBIDDEN");
  assert.match(denied.json.error.message, /sales\.refund/);
  // Company B must never observe company A's pending settlements.
  const foreign = await call("/api/v1/payments/refunds", {
    session: otherSession,
  });
  assert.equal(foreign.status, 200);
  assert.ok(
    !foreign.json.data.items.some((r: any) => r.id === mine.refund.id),
    "cross-tenant refund ids never list",
  );
});
