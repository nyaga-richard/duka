import { postJournal, reverseJournal } from "@duka/accounting";
import { fixture } from "./helper.ts";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pool, transaction, one, digest } from "../../apps/api/src/db.ts";
import {
  configureUser,
  configureRole,
} from "../../apps/api/src/services/admin.ts";
import {
  totp,
  setupMfa,
  enableMfa,
  actorFromToken,
  requestReset,
  processMailJob,
  resetPassword,
  rateLimit,
} from "../../apps/api/src/services/auth.ts";
import { postStockDocument } from "../../apps/api/src/services/inventory.ts";
import { productSchema } from "@duka/shared";
import { createProduct } from "../../apps/api/src/services/catalog.ts";
let server: Server, base: string;
process.env.LOG_LEVEL = "silent";
before(async () => {
  await pool.query("DELETE FROM rate_limit_buckets WHERE key=ANY($1::text[])", [
    [
      "login:ip:127.0.0.1",
      "login:ip:::ffff:127.0.0.1",
      "reset:127.0.0.2",
      "reset:127.0.0.7",
      "reset:127.0.0.8",
      "reset:127.0.0.1",
      "reset:::ffff:127.0.0.1",
      "reset-complete:127.0.0.1",
      "reset-complete:::ffff:127.0.0.1",
    ].map(digest),
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
beforeEach(async () => {
  await pool.query("DELETE FROM rate_limit_buckets WHERE key=ANY($1::text[])", [
    ["login:ip:127.0.0.1", "login:ip:::ffff:127.0.0.1"].map(digest),
  ]);
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
  return {
    response,
    status: response.status,
    data: json.data,
    error: json.error,
    json,
  };
}
async function signIn(
  email: string,
  password = "TestSecurePass-2026",
  code?: string,
): Promise<Session> {
  const r = await call("/api/v1/auth/login", {
    method: "POST",
    body: { email, password, ...(code ? { totp: code } : {}) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.error));
  const cookie = r.response.headers.get("set-cookie")!.split(";")[0];
  return {
    cookie,
    csrf: r.data.csrf_token,
    token: cookie.slice(cookie.indexOf("=") + 1),
  };
}
test("HTTP authentication, secure cookie flags, CSRF, origin, schema and idempotency headers fail closed", async () => {
  const f = await fixture();
  const session = await signIn(f.actor.email);
  const r = await call("/api/v1/auth/me", { session });
  assert.equal(r.data.actor.id, f.userId);
  assert.equal(r.data.actor.csrf_token, undefined);
  assert.equal(r.response.headers.get("cache-control"), "no-store");
  assert.ok(r.response.headers.get("x-content-type-options"));
  const stored = (
    await pool.query("SELECT token_hash FROM sessions WHERE user_id=$1", [
      f.userId,
    ])
  ).rows[0];
  assert.equal(stored.token_hash, digest(session.token));
  assert.notEqual(stored.token_hash, session.token);
  const login = await call("/api/v1/auth/login", {
    method: "POST",
    body: { email: f.actor.email, password: "TestSecurePass-2026" },
  });
  assert.match(login.response.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(login.response.headers.get("set-cookie")!, /SameSite=Lax/);
  assert.equal((await call("/api/v1/products")).status, 401);
  assert.equal(
    (
      await call("/api/v1/products", {
        method: "POST",
        session,
        body: {},
        headers: { "X-CSRF-Token": "" },
      })
    ).error.code,
    "CSRF_INVALID",
  );
  assert.equal(
    (
      await call("/api/v1/products", {
        method: "POST",
        session,
        body: {},
        headers: { origin: "https://attacker.example" },
      })
    ).error.code,
    "ORIGIN_DENIED",
  );
  assert.equal(
    (
      await call("/api/v1/shifts/open", {
        method: "POST",
        session,
        body: {
          register_id: f.registerId,
          opening_float: "0",
          created_by: randomUUID(),
        },
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await call("/api/v1/shifts/open", {
        method: "POST",
        session,
        body: { register_id: f.registerId, opening_float: "0" },
      })
    ).error.code,
    "IDEMPOTENCY_REQUIRED",
  );
  const payload = { register_id: f.registerId, opening_float: "0" };
  const a = await call("/api/v1/shifts/open", {
    method: "POST",
    session,
    body: payload,
    headers: { "Idempotency-Key": "http-shift-test-key" },
  });
  assert.equal(a.status, 200, JSON.stringify(a.error));
  const b = await call("/api/v1/shifts/open", {
    method: "POST",
    session,
    body: payload,
    headers: { "Idempotency-Key": "http-shift-test-key" },
  });
  assert.deepEqual(b.data, a.data);
  assert.equal(
    (
      await call("/api/v1/shifts/open", {
        method: "POST",
        session,
        body: { ...payload, opening_float: "1" },
        headers: { "Idempotency-Key": "http-shift-test-key" },
      })
    ).error.code,
    "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(
    (await call("/api/v1/products?unexpected=1", { session })).status,
    422,
  );
  assert.equal(
    (await call("/api/v1/auth/logout", { method: "POST", session, body: {} }))
      .status,
    200,
  );
  assert.equal((await call("/api/v1/auth/me", { session })).status, 401);
});
test("HTTP tenant/branch/warehouse isolation and role restrictions survive guessed IDs and read filters", async () => {
  const f = await fixture(),
    other = await fixture();
  let productId = "",
    branchId = "",
    warehouseId = "";
  await transaction(f.actor, async (ctx) => {
    branchId = (
      await ctx.db.query(
        "INSERT INTO branches(company_id,code,name) VALUES($1,'SECOND','Second branch') RETURNING id",
        [f.companyId],
      )
    ).rows[0].id;
    warehouseId = (
      await ctx.db.query(
        "INSERT INTO warehouses(company_id,branch_id,code,name) VALUES($1,$2,'SECOND','Second store') RETURNING id",
        [f.companyId, branchId],
      )
    ).rows[0].id;
  });
  await transaction(other.actor, async (ctx) => {
    const u = await one(
        ctx,
        "SELECT id FROM units WHERE company_id=$1 LIMIT 1",
        [other.companyId],
      ),
      tax = await one(
        ctx,
        "SELECT id FROM tax_rules WHERE company_id=$1 LIMIT 1",
        [other.companyId],
      );
    productId = (
      await createProduct(
        ctx,
        productSchema.parse({
          name: "Private foreign product",
          sku: "PRIVATE",
          unit_id: u.id,
          tax_rule_id: tax.id,
          price: "10",
        }),
      )
    ).id;
  });
  const session = await signIn(f.actor.email);
  assert.equal(
    (await call("/api/v1/products/" + productId, { session })).status,
    404,
  );
  assert.equal(
    (await call("/api/v1/products?warehouse_id=" + warehouseId, { session }))
      .error.code,
    "WAREHOUSE_FORBIDDEN",
  );
  assert.equal(
    (await call("/api/v1/sales?branch_id=" + branchId, { session })).error.code,
    "BRANCH_FORBIDDEN",
  );
  const user = await transaction(f.actor, async (ctx) => {
    const role = await one(
      ctx,
      "SELECT id FROM roles WHERE company_id=$1 AND name='Cashier'",
      [f.companyId],
    );
    return configureUser(ctx, {
      name: "Restricted cashier",
      email: randomUUID() + "@example.test",
      password: "CashierSecure-2026",
      role_ids: [role.id],
      branch_ids: [f.branchId],
      warehouse_ids: [f.warehouseId],
    });
  });
  const cashier = await signIn(user.email, "CashierSecure-2026");
  assert.equal(
    (await call("/api/v1/accounting/journals", { session: cashier })).status,
    403,
  );
  assert.equal((await call("/api/v1/users", { session: cashier })).status, 403);
  assert.equal(
    (await call("/api/v1/shifts", { session: cashier })).status,
    200,
  );
  assert.equal(
    (await call("/api/v1/auth/sessions", { session: cashier })).data.items
      .length,
    1,
  );
  const own = await call("/api/v1/auth/sessions", { session });
  const adminSessionId = own.data.items[0].id;
  assert.equal(
    (
      await call("/api/v1/auth/sessions/" + adminSessionId + "/revoke", {
        method: "POST",
        session: cashier,
        body: {},
        headers: { "Idempotency-Key": "foreign-revoke-session" },
      })
    ).status,
    404,
  );
});
test("accountant can review shifts without permission to open a till", async () => {
  const f = await fixture();
  const user = await transaction(f.actor, async (ctx) => {
    const role = await one(
      ctx,
      "SELECT id FROM roles WHERE company_id=$1 AND name='Accountant'",
      [f.companyId],
    );
    return configureUser(ctx, {
      name: "Accounts reviewer",
      email: randomUUID() + "@example.test",
      password: "AccountsSecure-2026",
      role_ids: [role.id],
      branch_ids: [f.branchId],
      warehouse_ids: [f.warehouseId],
    });
  });
  const session = await signIn(user.email, "AccountsSecure-2026");
  assert.equal((await call("/api/v1/shifts", { session })).status, 200);
  assert.equal(
    (
      await call("/api/v1/shifts/open", {
        method: "POST",
        session,
        body: { register_id: f.registerId, opening_float: "0" },
        headers: { "Idempotency-Key": "accountant-cannot-open" },
      })
    ).status,
    403,
  );
});
test("password reset tokens are private, single-use and revoke sessions; MFA requires an unused valid code", async () => {
  const f = await fixture();
  const first = await signIn(f.actor.email);
  await requestReset(f.actor.email, "127.0.0.2");
  const mail = (
    await pool.query(
      "SELECT body FROM mail_outbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1",
      [f.actor.email],
    )
  ).rows[0];
  const token = new URL(mail.body.match(/https?:\/\/\S+/)![0]).searchParams.get(
    "token",
  );
  assert.ok(token);
  assert.equal(
    (
      await call("/api/v1/auth/reset-password", {
        method: "POST",
        body: { token, password: "NewSecurePass-2026" },
      })
    ).status,
    200,
  );
  assert.equal((await call("/api/v1/auth/me", { session: first })).status, 401);
  assert.equal(
    (
      await call("/api/v1/auth/reset-password", {
        method: "POST",
        body: { token, password: "OtherSecurePass-2026" },
      })
    ).error.code,
    "INVALID_RESET",
  );
  const signed = await signIn(f.actor.email, "NewSecurePass-2026");
  const otherSession = await signIn(f.actor.email, "NewSecurePass-2026");
  const actor = await actorFromToken(signed.token);
  const setup = await transaction(actor, (ctx) =>
    setupMfa(ctx, "NewSecurePass-2026"),
  );
  await pool.query(
    "UPDATE identities SET mfa_setup_expires_at=now()-interval '1 minute' WHERE id=$1",
    [actor.id],
  );
  await assert.rejects(
    () => transaction(actor, (ctx) => enableMfa(ctx, totp(setup.secret))),
    /Provisioning expired/,
  );
  await pool.query(
    "UPDATE identities SET mfa_setup_expires_at=now()+interval '15 minutes' WHERE id=$1",
    [actor.id],
  );
  const consumedCode = totp(setup.secret);
  await transaction(actor, (ctx) => enableMfa(ctx, consumedCode));
  assert.equal(
    (await call("/api/v1/auth/me", { session: otherSession })).status,
    401,
  );
  assert.equal(
    (
      await call("/api/v1/auth/login", {
        method: "POST",
        body: { email: f.actor.email, password: "NewSecurePass-2026" },
      })
    ).error.code,
    "MFA_REQUIRED",
  );
  assert.equal(
    (
      await call("/api/v1/auth/login", {
        method: "POST",
        body: {
          email: f.actor.email,
          password: "NewSecurePass-2026",
          totp: consumedCode,
        },
      })
    ).error.code,
    "INVALID_MFA",
  );
  const next = totp(setup.secret, Math.floor(Date.now() / 30000) + 1);
  await signIn(f.actor.email, "NewSecurePass-2026", next);
  assert.equal(
    (
      await call("/api/v1/auth/login", {
        method: "POST",
        body: {
          email: f.actor.email,
          password: "NewSecurePass-2026",
          totp: next,
        },
      })
    ).error.code,
    "INVALID_MFA",
  );
});
test("public API reference, readiness and bounded error responses expose no stack traces", async () => {
  assert.equal((await call("/health/live")).status, 200);
  const ready = await call("/health/ready");
  assert.equal(ready.status, 200);
  assert.equal(ready.json.status, "ready");
  const spec = await call("/api/v1/openapi.json");
  assert.equal(spec.json.openapi, "3.1.0");
  assert.ok(spec.json.paths["/api/v1/sales"].post.requestBody);
  const f = await fixture(),
    session = await signIn(f.actor.email);
  const err = await call("/api/v1/products/not-a-uuid", { session });
  assert.equal(err.status, 422);
  assert.equal(err.error.stack, undefined);
  assert.ok(err.error.request_id);
});

test("expense plus receipt is atomic, replay-safe and private across tenants", async () => {
  const f = await fixture(),
    session = await signIn(f.actor.email);
  const { category, tax } = await transaction(f.actor, async (ctx) => ({
    category: await one(
      ctx,
      "SELECT id FROM expense_categories WHERE company_id=$1 LIMIT 1",
      [f.companyId],
    ),
    tax: await one(
      ctx,
      "SELECT id FROM tax_rules WHERE company_id=$1 AND code='VAT16'",
      [f.companyId],
    ),
  }));
  const body = {
    branch_id: f.branchId,
    category_id: category.id,
    tax_rule_id: tax.id,
    description: "Private receipt atomic test",
    net: "100.00",
    attachment: {
      filename: "receipt.png",
      mime_type: "image/png",
      base64: Buffer.from("not a PNG").toString("base64"),
    },
  };
  const bad = await call("/api/v1/expenses", {
    method: "POST",
    session,
    body,
    headers: { "Idempotency-Key": "expense-with-invalid-receipt" },
  });
  assert.equal(bad.error.code, "FILE_SIGNATURE");
  await transaction(f.actor, async (ctx) =>
    assert.equal(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM expenses WHERE company_id=$1",
          [f.companyId],
        )
      ).n,
      0,
    ),
  );
  body.attachment.base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=";
  const opts = {
    method: "POST",
    session,
    body,
    headers: { "Idempotency-Key": "expense-with-valid-receipt" },
  };
  const good = await call("/api/v1/expenses", opts);
  assert.equal(good.status, 200, JSON.stringify(good.error));
  assert.deepEqual((await call("/api/v1/expenses", opts)).data, good.data);
  const attachments = await call(
    `/api/v1/expenses/${good.data.id}/attachments`,
    { session },
  );
  assert.equal(attachments.data.items.length, 1);
  const id = attachments.data.items[0].id;
  const file = await fetch(base + "/api/v1/attachments/" + id, {
    headers: { cookie: session.cookie },
  });
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-disposition")!, /^attachment;/);
  assert.deepEqual(
    Buffer.from(await file.arrayBuffer()),
    Buffer.from(body.attachment.base64, "base64"),
  );
  const other = await fixture(),
    outsider = await signIn(other.actor.email);
  assert.equal(
    (await call("/api/v1/attachments/" + id, { session: outsider })).status,
    404,
  );
  await transaction(f.actor, async (ctx) =>
    assert.equal(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM expenses WHERE company_id=$1",
          [f.companyId],
        )
      ).n,
      1,
    ),
  );
});
test("cashiers can sell but cannot extract catalog costs, sale costs or dashboard margins", async () => {
  const f = await fixture();
  const { p, user, cash } = await transaction(f.actor, async (ctx) => {
    const u = await one(
        ctx,
        "SELECT id FROM units WHERE company_id=$1 AND symbol='pc'",
        [f.companyId],
      ),
      t = await one(
        ctx,
        "SELECT id FROM tax_rules WHERE company_id=$1 AND code='VAT16'",
        [f.companyId],
      );
    const p = await createProduct(
      ctx,
      productSchema.parse({
        name: "Protected-cost item",
        sku: "PROTECTED",
        unit_id: u.id,
        tax_rule_id: t.id,
        price: "116",
        purchase_cost: "50",
      }),
    );
    await postStockDocument(ctx, {
      type: "opening",
      warehouse_id: f.warehouseId,
      reason: "Cost privacy fixture opening",
      lines: [{ product_id: p.id, quantity: "2", unit_cost: "50" }],
    });
    const role = await one(
      ctx,
      "SELECT id FROM roles WHERE company_id=$1 AND name='Cashier'",
      [f.companyId],
    );
    const user = await configureUser(ctx, {
      name: "Private-cost cashier",
      email: randomUUID() + "@example.test",
      password: "CashierSecure-2026",
      role_ids: [role.id],
      branch_ids: [f.branchId],
      warehouse_ids: [f.warehouseId],
    });
    return {
      p,
      user,
      cash: await one(
        ctx,
        "SELECT id FROM payment_methods WHERE company_id=$1 AND kind='cash'",
        [f.companyId],
      ),
    };
  });
  const owner = await signIn(f.actor.email);
  assert.equal(
    (await call("/api/v1/products/" + p.id, { session: owner })).data
      .purchase_cost,
    "50.000000",
  );
  const session = await signIn(user.email, "CashierSecure-2026");
  const item = (await call("/api/v1/products", { session })).data.items[0];
  for (const field of ["purchase_cost", "average_cost", "stock_value"])
    assert.equal(item[field], undefined);
  assert.equal(
    (await call("/api/v1/products/" + p.id, { session })).data.purchase_cost,
    undefined,
  );
  assert.equal(
    (await call("/api/v1/dashboard", { session })).data.totals.gross_profit,
    null,
  );
  await call("/api/v1/shifts/open", {
    method: "POST",
    session,
    body: { register_id: f.registerId, opening_float: "0" },
    headers: { "Idempotency-Key": "private-cost-shift" },
  });
  const sale = await call("/api/v1/sales", {
    method: "POST",
    session,
    body: {
      register_id: f.registerId,
      lines: [{ product_id: p.id, quantity: "1" }],
      payments: [{ method_id: cash.id, amount: "116" }],
    },
    headers: { "Idempotency-Key": "private-cost-checkout" },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.error));
  assert.equal(sale.data.cost, undefined);
  const invoice = (await call("/api/v1/sales/" + sale.data.id, { session }))
    .data;
  assert.equal(invoice.cost, undefined);
  assert.equal(invoice.lines[0].cost, undefined);
  assert.equal(invoice.lines[0].components[0].value, undefined);
  assert.equal(
    (await call("/api/v1/sales", { session })).data.items[0].cost,
    undefined,
  );
});
test("concurrent reset links serialize on identity and rate counters persist independently", async () => {
  const f = await fixture(),
    session = await signIn(f.actor.email);
  const tokens: string[] = [];
  for (let i = 0; i < 2; i++) {
    await requestReset(f.actor.email, "127.0.0.7");
    const mail = (
      await pool.query(
        "SELECT body FROM mail_outbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1",
        [f.actor.email],
      )
    ).rows[0];
    tokens.push(
      new URL(mail.body.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!,
    );
  }
  assert.notEqual(tokens[0], tokens[1]);
  const results = await Promise.allSettled(
    tokens.map((token, i) => resetPassword(token, `RaceSecurePass-${i}-2026`)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal((await call("/api/v1/auth/me", { session })).status, 401);
  const key = "rate-regression:" + randomUUID();
  await rateLimit(key, 2, 60);
  await rateLimit(key, 2, 60);
  await assert.rejects(() => rateLimit(key, 2, 60), /Too many attempts/);
  assert.equal(
    (
      await pool.query("SELECT hits FROM rate_limit_buckets WHERE key=$1", [
        digest(key),
      ])
    ).rows[0].hits,
    3,
  );
});

test("public auth bodies are small and unauthorized financial uploads are rejected before parsing", async () => {
  const oversized = await call("/api/v1/auth/login", {
    method: "POST",
    body: { email: "x".repeat(20000), password: "NoSuchPass-2026" },
  });
  assert.equal(oversized.status, 413);
  const denied = await call("/api/v1/expenses", {
    method: "POST",
    body: { untrusted: "x".repeat(20000) },
  });
  assert.equal(denied.status, 401);
  const malformed = await fetch(base + "/api/v1/expenses", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: "{",
  });
  assert.equal(
    malformed.status,
    401,
    "Reject unauthenticated malformed JSON before parsing; do not produce a400 parser error",
  );
});

test("SMTP outages cannot change reset-request success; mail jobs retry with a lease and never send legacy development outbox", async () => {
  const f = await fixture(),
    previous = { mode: process.env.MAIL_MODE, url: process.env.SMTP_URL };
  try {
    process.env.MAIL_MODE = "smtp";
    process.env.SMTP_URL = "smtp://127.0.0.1:1";
    await requestReset(f.actor.email, "127.0.0.8");
    await requestReset("absent-" + randomUUID() + "@example.test", "127.0.0.8");
    const queued = (
      await pool.query(
        "SELECT * FROM mail_outbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1",
        [f.actor.email],
      )
    ).rows[0];
    assert.equal(queued.delivery_mode, "smtp");
    assert.equal(queued.status, "pending");
    assert.equal(await processMailJob(queued.id), false);
    const failed = (
      await pool.query("SELECT * FROM mail_outbox WHERE id=$1", [queued.id])
    ).rows[0];
    assert.equal(failed.status, "pending");
    assert.equal(failed.attempts, 1);
    assert.ok(failed.last_error);
    assert.ok(failed.body.includes("reset-password"));
    assert.equal(await processMailJob(queued.id), false);
    const legacy = (
      await pool.query(
        "INSERT INTO mail_outbox(recipient,subject,body,delivery_mode) VALUES($1,'Legacy outbox probe','Development only','outbox') RETURNING id",
        [f.actor.email],
      )
    ).rows[0];
    assert.equal(await processMailJob(legacy.id), false);
    assert.equal(
      (
        await pool.query("SELECT attempts FROM mail_outbox WHERE id=$1", [
          legacy.id,
        ])
      ).rows[0].attempts,
      0,
    );
    // Expire only this disposable fixture's test token/job, never financial data.
    await pool.query(
      "UPDATE mail_outbox SET status='expired',body='',expires_at=now()-interval '1 second' WHERE id=$1",
      [queued.id],
    );
    await pool.query(
      "UPDATE password_resets SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [f.userId],
    );
  } finally {
    if (previous.mode === undefined) delete process.env.MAIL_MODE;
    else process.env.MAIL_MODE = previous.mode;
    if (previous.url === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = previous.url;
  }
});

test("a database failure after receipt bytes are written rolls back the expense, metadata and new private file", async () => {
  const f = await fixture(),
    session = await signIn(f.actor.email),
    name = "receipt_probe_" + randomUUID().replaceAll("-", "");
  const refs = await transaction(f.actor, async (ctx) => ({
    category: (
      await one(
        ctx,
        "SELECT id FROM expense_categories WHERE company_id=$1 LIMIT 1",
        [f.companyId],
      )
    ).id,
    tax: (
      await one(
        ctx,
        "SELECT id FROM tax_rules WHERE company_id=$1 AND code='VAT16'",
        [f.companyId],
      )
    ).id,
  }));
  await pool.query(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.companyId}'::uuid THEN RAISE EXCEPTION 'Injected receipt metadata failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${name} BEFORE INSERT ON attachments FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  try {
    const response = await call("/api/v1/expenses", {
      method: "POST",
      session,
      headers: { "Idempotency-Key": randomUUID() },
      body: {
        branch_id: f.branchId,
        category_id: refs.category,
        tax_rule_id: refs.tax,
        net: "100",
        description: "Injected receipt rollback regression",
        attachment: {
          filename: "receipt.png",
          mime_type: "image/png",
          base64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=",
        },
      },
    });
    assert.equal(response.status, 500);
    await transaction(f.actor, async (ctx) => {
      assert.equal(
        (
          await one(
            ctx,
            "SELECT count(*)::int AS n FROM expenses WHERE company_id=$1",
            [f.companyId],
          )
        ).n,
        0,
      );
      assert.equal(
        (
          await one(
            ctx,
            "SELECT count(*)::int AS n FROM attachments WHERE company_id=$1",
            [f.companyId],
          )
        ).n,
        0,
      );
    });
    assert.deepEqual(
      await readdir(path.join(process.env.UPLOAD_DIR!, f.companyId)),
      [],
    );
  } finally {
    await pool.query(
      `DROP TRIGGER ${name} ON attachments; DROP FUNCTION ${name}()`,
    );
  }
});

test("period close rejects an independently corrupted AR control and succeeds after an auditable reversal", async () => {
  const f = await fixture(),
    session = await signIn(f.actor.email),
    date = new Date().toISOString().slice(0, 10);
  const probe = await transaction(f.actor, async (ctx) => ({
    period: (
      await one(
        ctx,
        "SELECT id FROM accounting_periods WHERE company_id=$1 AND start_date<=$2 AND end_date>=$2",
        [f.companyId, date],
      )
    ).id,
    journal: await postJournal(ctx, {
      branchId: f.branchId,
      date,
      sourceType: "manual",
      sourceId: randomUUID(),
      description: "Raw control integrity test",
      lines: [
        { account: "ar", debit: "1" },
        { account: "equity", credit: "1" },
      ],
    }),
  }));
  const rejected = await call(
    `/api/v1/accounting/periods/${probe.period}/status`,
    {
      method: "POST",
      session,
      headers: { "Idempotency-Key": randomUUID() },
      body: {
        status: "closed",
        reason: "Independent closing reconciliation regression",
      },
    },
  );
  assert.equal(rejected.status, 409);
  assert.equal(rejected.error.code, "SUBLEDGERS_UNRECONCILED");
  await transaction(f.actor, (ctx) =>
    reverseJournal(
      ctx,
      probe.journal.id,
      date,
      "Auditable reversal of test-only raw control probe",
    ),
  );
  const closed = await call(
    `/api/v1/accounting/periods/${probe.period}/status`,
    {
      method: "POST",
      session,
      headers: { "Idempotency-Key": randomUUID() },
      body: {
        status: "closed",
        reason: "Balanced company-wide controls verified",
      },
    },
  );
  assert.equal(closed.status, 200);
  assert.equal(closed.data.status, "closed");
});

test("offline device authorization validates active target branch, warehouse and sales-create membership", async () => {
  const f = await fixture(),
    owner = await signIn(f.actor.email);
  const target = await transaction(f.actor, async (ctx) => {
    const role = await one(
      ctx,
      "SELECT id FROM roles WHERE company_id=$1 AND name='Cashier'",
      [f.companyId],
    );
    const user = await configureUser(ctx, {
      name: "Offline scope target",
      email: randomUUID() + "@example.test",
      password: "OfflineTarget-2026",
      role_ids: [role.id],
      branch_ids: [],
      warehouse_ids: [],
    });
    return { ...user, role_id: role.id };
  });
  const authorize = () =>
    call("/api/v1/offline/devices", {
      method: "POST",
      session: owner,
      headers: { "Idempotency-Key": randomUUID() },
      body: {
        user_id: target.id,
        register_id: f.registerId,
        label: "Explicit scope regression",
        max_sale_amount: "500",
      },
    });
  assert.equal((await authorize()).error.code, "DEVICE_USER_BRANCH");
  await transaction(f.actor, (ctx) =>
    ctx.db.query(
      "INSERT INTO user_branches(company_id,user_id,branch_id) VALUES($1,$2,$3)",
      [f.companyId, target.id, f.branchId],
    ),
  );
  assert.equal((await authorize()).error.code, "DEVICE_USER_SCOPE");
  await transaction(f.actor, async (ctx) => {
    await ctx.db.query(
      "INSERT INTO user_warehouses(company_id,user_id,warehouse_id) VALUES($1,$2,$3)",
      [f.companyId, target.id, f.warehouseId],
    );
    await ctx.db.query(
      "DELETE FROM role_permissions WHERE company_id=$1 AND role_id=$2 AND permission='sales.create'",
      [f.companyId, target.role_id],
    );
  });
  assert.equal((await authorize()).error.code, "DEVICE_USER_SCOPE");
  await transaction(f.actor, (ctx) =>
    ctx.db.query(
      "INSERT INTO role_permissions(company_id,role_id,permission) VALUES($1,$2,'sales.create')",
      [f.companyId, target.role_id],
    ),
  );
  assert.equal((await authorize()).status, 200);
  await transaction(f.actor, (ctx) =>
    ctx.db.query(
      "DELETE FROM user_warehouses WHERE company_id=$1 AND user_id=$2 AND warehouse_id=$3",
      [f.companyId, f.actor.id, f.warehouseId],
    ),
  );
  assert.equal((await authorize()).error.code, "WAREHOUSE_FORBIDDEN");
  await transaction(f.actor, (ctx) =>
    ctx.db.query(
      "INSERT INTO user_warehouses(company_id,user_id,warehouse_id) VALUES($1,$2,$3)",
      [f.companyId, f.actor.id, f.warehouseId],
    ),
  );
  await pool.query(
    "UPDATE identities SET status='inactive' WHERE company_id=$1 AND id=$2",
    [f.companyId, target.id],
  );
  assert.equal((await authorize()).status, 404);
});

test("isolated workspace cookies are partitioned, distinct from legacy cookies, cleared correctly, and never enabled in production", async () => {
  const saved = {
    mode: process.env.NODE_ENV,
    preview: process.env.WORKSPACE_PREVIEW,
    demo: process.env.DEMO_MODE,
    secure: process.env.COOKIE_SECURE,
  };
  try {
    process.env.WORKSPACE_PREVIEW = "false";
    const legacy = await fixture(),
      legacySession = await signIn(legacy.actor.email);
    const f = await fixture();
    process.env.WORKSPACE_PREVIEW = "true";
    process.env.DEMO_MODE = "true";
    process.env.COOKIE_SECURE = "true";
    const r = await call("/api/v1/auth/login", {
      method: "POST",
      body: { email: f.actor.email, password: "TestSecurePass-2026" },
    });
    assert.equal(r.status, 200);
    const header = r.response.headers.get("set-cookie")!;
    assert.match(header, /^duka_workspace_session=/);
    for (const flag of [/HttpOnly/, /Secure/, /SameSite=None/, /Partitioned/])
      assert.match(header, flag);
    const cookie = header.split(";")[0],
      session = {
        cookie,
        csrf: r.data.csrf_token,
        token: cookie.slice(cookie.indexOf("=") + 1),
      };
    assert.equal(
      (await call("/api/v1/auth/me", { session: legacySession })).status,
      401,
    );
    const mixed = await call("/api/v1/auth/me", {
      headers: { cookie: legacySession.cookie + "; " + cookie },
    });
    assert.equal(mixed.data.actor.id, f.userId);
    const out = await call("/api/v1/auth/logout", {
      method: "POST",
      body: {},
      session,
    });
    assert.equal(out.status, 200);
    assert.match(
      out.response.headers.get("set-cookie")!,
      /duka_workspace_session=.*Max-Age=0/,
    );
    assert.match(out.response.headers.get("set-cookie")!, /Partitioned/);
    assert.equal((await call("/api/v1/auth/me", { session })).status, 401);
    // Even importing createApp without the production entry point cannot relax cookies.
    process.env.NODE_ENV = "production";
    const prod = await call("/api/v1/auth/login", {
      method: "POST",
      body: { email: f.actor.email, password: "TestSecurePass-2026" },
    });
    assert.equal(prod.status, 200);
    const safe = prod.response.headers.get("set-cookie")!;
    assert.match(safe, /^duka_session=/);
    assert.match(safe, /SameSite=Lax/);
    assert.doesNotMatch(safe, /Partitioned|SameSite=None/);
  } finally {
    for (const [key, value] of Object.entries({
      NODE_ENV: saved.mode,
      WORKSPACE_PREVIEW: saved.preview,
      DEMO_MODE: saved.demo,
      COOKIE_SECURE: saved.secure,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("advance API separates customer-receipt authority from supplier-payment authority", async () => {
  const { saveContact } = await import(
    "../../apps/api/src/services/catalog.ts"
  );
  const { customerSchema, supplierSchema } = await import("@duka/shared");
  const { settleContact } = await import(
    "../../apps/api/src/services/payments.ts"
  );
  const f = await fixture();
  const users = await transaction(f.actor, async (ctx) => {
    const customer = await saveContact(
        ctx,
        "customer",
        customerSchema.parse({
          name: "Advance customer",
          code: "ADV-C",
          credit_limit: "0",
        }),
      ),
      supplier = await saveContact(
        ctx,
        "supplier",
        supplierSchema.parse({ name: "Advance supplier", code: "ADV-S" }),
      ),
      bank = await one(
        ctx,
        "SELECT id FROM payment_methods WHERE company_id=$1 AND kind='bank'",
        [f.companyId],
      );
    await settleContact(ctx, "customer", {
      branch_id: f.branchId,
      contact_id: customer.id,
      payment: { method_id: bank.id, amount: "100", reference: randomUUID() },
      allocations: [],
    });
    await settleContact(ctx, "supplier", {
      branch_id: f.branchId,
      contact_id: supplier.id,
      payment: { method_id: bank.id, amount: "40", reference: randomUUID() },
      allocations: [],
    });
    const out = [];
    for (const [kind, permission] of [
      ["receiver", "payments.receive"],
      ["payer", "payments.pay"],
    ] as const) {
      const role = await configureRole(ctx, {
        name: kind,
        permissions: [permission],
        approval_limit: "0",
      });
      out.push(
        await configureUser(ctx, {
          name: kind,
          email: randomUUID() + "@example.test",
          password: "AdvanceScope-2026",
          role_ids: [role.id],
          branch_ids: [f.branchId],
          warehouse_ids: [f.warehouseId],
        }),
      );
    }
    return out;
  });
  for (const [index, user] of users.entries()) {
    const session = await signIn(user.email, "AdvanceScope-2026"),
      response = await call("/api/v1/payments/advances", { session });
    assert.equal(response.status, 200);
    assert.equal(response.data.total, 1);
    const row = response.data.items[0];
    assert.equal(index === 0 ? row.supplier_id : row.customer_id, null);
    assert.equal(row.available, index === 0 ? "100.00" : "40.00");
  }
});
