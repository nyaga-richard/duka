import { fixture } from "./helper.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pool, transaction, one } from "../../apps/api/src/db.ts";
import { configureUser } from "../../apps/api/src/services/admin.ts";
import "../../apps/api/src/routes/index.ts";

process.env.LOG_LEVEL = "silent";
let server: Server, base: string;

before(async () => {
  await pool.query("DELETE FROM rate_limit_buckets");
  const { createApp } = await import("../../apps/api/src/app.ts");
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + (server.address() as any).port;
});
after(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  await pool.end();
});

async function call(path: string, options: any = {}) {
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    ...(options.body !== undefined
      ? { "content-type": "application/json" }
      : {}),
    ...(options.session
      ? {
          cookie: options.session.cookie,
          "X-CSRF-Token": options.session.csrf,
          ...(options.method && options.method !== "GET"
            ? { "Idempotency-Key": randomUUID() }
            : {}),
        }
      : {}),
  };
  const res = await fetch(base + path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data, json, headers: res.headers };
}
async function signIn(email: string, password = "TestSecurePass-2026") {
  await pool.query("DELETE FROM rate_limit_buckets"); // sweep-friendly
  const r = await call("/api/v1/auth/login", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return { cookie, csrf: r.data.csrf_token };
}

/** User whose single role carries exactly the requested permissions. */
async function scopedUser(f: any, perms: string[]) {
  return transaction(f.actor, async (ctx) => {
    const role = await one(
      ctx,
      "INSERT INTO roles(id,company_id,name) VALUES(gen_random_uuid(),$1,$2) RETURNING id",
      [f.companyId, `Device admin test ${randomUUID().slice(0, 8)}`],
    );
    for (const p of perms)
      await ctx.db.query(
        "INSERT INTO role_permissions(company_id,role_id,permission) VALUES($1,$2,$3)",
        [f.companyId, role.id, p],
      );
    const warehouse = await one(
      ctx,
      "SELECT id FROM warehouses WHERE company_id=$1 LIMIT 1",
      [f.companyId],
    );
    return configureUser(ctx, {
      name: "Device admin test",
      email: randomUUID() + "@example.test",
      password: "TestSecurePass-2026",
      role_ids: [role.id],
      branch_ids: [f.branchId],
      warehouse_ids: [warehouse.id],
    });
  });
}

test("offline device administration: dedicated permission, preserved fallback, fail-closed without either", async () => {
  const f = await fixture();
  const register = await transaction(f.actor, (ctx) =>
    one(ctx, "SELECT id FROM registers WHERE company_id=$1 LIMIT 1", [
      f.companyId,
    ]),
  );
  const cases: Array<[string, string[], number]> = [
    ["legacy sales.price_override fallback still authorizes", ["sales.create", "sales.price_override"], 200],
    ["dedicated offline.manage authorizes", ["sales.create", "offline.manage"], 200],
    ["sales.create alone is refused", ["sales.create"], 403],
  ];
  for (const [label, perms, expect] of cases) {
    const user = (await scopedUser(f, perms)) as any;
    const session = await signIn(user.email);
    const authorize = await call("/api/v1/offline/devices", {
      method: "POST",
      session,
      body: {
        user_id: f.actor.id,
        register_id: register.id,
        label: "Backroom PDA",
        max_sale_amount: "50000",
      },
    });
    assert.equal(authorize.status, expect, `${label} -> ${authorize.status} ${JSON.stringify(authorize.json)}`);
    if (expect === 200) {
      const revoke = await call(
        `/api/v1/offline/devices/${authorize.data.id}/revoke`,
        { method: "POST", session },
      );
      assert.equal(revoke.status, 200, `${label} revoke -> ${revoke.status}`);
    } else {
      const revoke = await call(
        `/api/v1/offline/devices/${randomUUID()}/revoke`,
        { method: "POST", session },
      );
      assert.equal(revoke.status, 403, `${label} revoke -> ${revoke.status}`);
    }
  }
});
