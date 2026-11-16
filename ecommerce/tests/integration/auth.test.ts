import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { apiClient, startTestContext, adminClient, customerClient, seedAdmin, type TestContext } from "../helpers.ts";

let ctx: TestContext;

before(async () => {
  ctx = await startTestContext();
});

after(async () => {
  await ctx.cleanup();
});

test("registration creates a customer session with a CSRF token", async () => {
  const client = apiClient(ctx.baseUrl);
  const response = await client.post("/api/v1/auth/register", {
    email: "amina@example.test",
    password: "ShopperPassword2026!",
    first_name: "Amina",
    last_name: "Wanjiku",
    phone: "0712345678",
  });
  assert.equal(response.status, 201);
  assert.ok(response.data.csrf_token);
  assert.equal(response.data.customer.email, "amina@example.test");
  assert.equal(response.body.meta.request_id, response.headers.get("x-request-id"));
  assert.ok(client.cookies.has("ecom_session"), "session cookie set");
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/i);

  const me = await client.get("/api/v1/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.kind, "customer");
  assert.equal(me.data.customer.first_name, "Amina");
  assert.equal(me.data.csrf_token, response.data.csrf_token);
});

test("duplicate registration is refused without leaking the existing account", async () => {
  const client = apiClient(ctx.baseUrl);
  const response = await client.post("/api/v1/auth/register", {
    email: "amina@example.test",
    password: "AnotherPassword2026!",
    first_name: "Amina",
    last_name: "Wanjiku",
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "EMAIL_TAKEN");
});

test("registration validates payloads and rejects unknown fields", async () => {
  const client = apiClient(ctx.baseUrl);
  const shortPassword = await client.post("/api/v1/auth/register", {
    email: "short@example.test",
    password: "short",
    first_name: "A",
    last_name: "B",
  });
  assert.equal(shortPassword.status, 422);
  assert.equal(shortPassword.body.error.code, "VALIDATION_ERROR");

  const unknownField = await client.post("/api/v1/auth/register", {
    email: "extra@example.test",
    password: "ShopperPassword2026!",
    first_name: "A",
    last_name: "B",
    role: "admin",
  });
  assert.equal(unknownField.status, 422);

  const badPhone = await client.post("/api/v1/auth/register", {
    email: "phone@example.test",
    password: "ShopperPassword2026!",
    first_name: "A",
    last_name: "B",
    phone: "0812000000",
  });
  assert.equal(badPhone.status, 422);
});

test("sign-in requires the right password and survives a fresh client", async () => {
  const wrong = apiClient(ctx.baseUrl);
  const bad = await wrong.post("/api/v1/auth/login", { email: "amina@example.test", password: "WrongPassword2026!" });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, "INVALID_CREDENTIALS");

  const client = apiClient(ctx.baseUrl);
  const good = await client.post("/api/v1/auth/login", { email: "amina@example.test", password: "ShopperPassword2026!" });
  assert.equal(good.status, 200);
  client.setCsrfFromBody(good.data);
  const me = await client.get("/api/v1/auth/me");
  assert.equal(me.data.authenticated, true);
});

test("cookies alone are not enough: state changes need CSRF and an allowed origin", async () => {
  const client = await customerClient(ctx.baseUrl, "csrf@example.test");

  const noCsrf = await client.request("POST", "/api/v1/auth/logout", { headers: { "x-csrf-token": undefined } });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error.code, "CSRF_INVALID");
  assert.equal(client.csrf, noCsrf.body.error.details?.csrf_token ?? client.csrf);

  const badOrigin = await client.request("POST", "/api/v1/auth/logout", { origin: "https://evil.example" });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.body.error.code, "ORIGIN_DENIED");

  const ok = await client.post("/api/v1/auth/logout");
  assert.equal(ok.status, 200);
  assert.equal(ok.data.signed_out, true);

  const afterLogout = await apiClient(ctx.baseUrl);
  afterLogout.cookies.set("ecom_session", client.cookies.get("ecom_session") ?? "revoked");
  const me = await afterLogout.get("/api/v1/auth/me");
  assert.equal(me.data.authenticated, false, "revoked cookie is rejected");
});

test("customer identities cannot enter the admin realm", async () => {
  const customer = await customerClient(ctx.baseUrl, "notadmin@example.test");
  const response = await customer.get("/api/v1/admin/orders");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "UNAUTHENTICATED");

  const admin = await adminClient(ctx.baseUrl, ctx.db);
  const adminOrders = await admin.get("/api/v1/admin/orders");
  assert.equal(adminOrders.status, 200);
  assert.ok(Array.isArray(adminOrders.data.items));
});

test("administrator sign-in uses a separate cookie and the customer cookie is ignored", async () => {
  await seedAdmin(ctx.db, "auditor", "auditor@shop.test");
  const client = apiClient(ctx.baseUrl);
  const login = await client.post("/api/v1/admin/auth/login", { email: "auditor@shop.test", password: "OwnerPassword2026!" });
  assert.equal(login.status, 200);
  assert.ok(client.cookies.has("ecom_admin_session"));
  assert.equal(client.cookies.has("ecom_session"), false, "the admin realm does not mint a storefront session");
  client.setCsrfFromBody(login.data);

  const me = await client.get("/api/v1/auth/me");
  assert.equal(me.data.kind, "admin");
  assert.deepEqual(me.data.admin.roles, ["auditor"]);
  assert.ok(me.data.admin.permissions.includes("audit.read"));

  const write = await client.patch("/api/v1/admin/products/1/status", { status: "archived" });
  assert.equal(write.status, 403, "auditor cannot mutate the catalogue");
  assert.equal(write.body.error.code, "FORBIDDEN");
  assert.match(write.body.error.message, /permission/i);
});

test("customer credentials are not valid in the admin realm", async () => {
  const client = apiClient(ctx.baseUrl);
  const login = await client.post("/api/v1/admin/auth/login", { email: "amina@example.test", password: "ShopperPassword2026!" });
  assert.equal(login.status, 401);
  assert.equal(login.body.error.code, "INVALID_CREDENTIALS");
});

test("guest sessions get their own identity and cannot be escalated", async () => {
  const guest = apiClient(ctx.baseUrl);
  const created = await guest.post("/api/v1/auth/guest", { email: "guest@example.test" });
  assert.equal(created.status, 201);
  assert.equal(created.data.guest, true);
  guest.setCsrfFromBody(created.data);

  const me = await guest.get("/api/v1/auth/me");
  assert.equal(me.data.kind, "guest");

  const second = await guest.post("/api/v1/auth/guest", {});
  assert.equal(second.status, 201);
  assert.equal(second.data.guest, false, "never silently replaces an existing identity");
  assert.equal(second.data.existing, "guest");

  const adminAttempt = await guest.get("/api/v1/admin/orders");
  assert.equal(adminAttempt.status, 401);
});

test("changing a password revokes other sessions and requires the current password", async () => {
  const first = await customerClient(ctx.baseUrl, "rotate@example.test");
  const second = apiClient(ctx.baseUrl);
  const login = await second.post("/api/v1/auth/login", { email: "rotate@example.test", password: "ShopperPassword2026!" });
  second.setCsrfFromBody(login.data);

  const wrongCurrent = await first.post("/api/v1/auth/change-password", {
    current_password: "NotMyPassword2026!",
    new_password: "BrandNewPassword2026!",
  });
  assert.equal(wrongCurrent.status, 401);

  const changed = await first.post("/api/v1/auth/change-password", {
    current_password: "ShopperPassword2026!",
    new_password: "BrandNewPassword2026!",
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.other_sessions_revoked, true);

  const secondMe = await second.get("/api/v1/auth/me");
  assert.equal(secondMe.data.authenticated, false, "other sessions are revoked");
  const firstMe = await first.get("/api/v1/auth/me");
  assert.equal(firstMe.data.authenticated, true, "current session survives");

  const newLogin = apiClient(ctx.baseUrl);
  const relogin = await newLogin.post("/api/v1/auth/login", { email: "rotate@example.test", password: "BrandNewPassword2026!" });
  assert.equal(relogin.status, 200);
  const oldLogin = apiClient(ctx.baseUrl);
  const rejected = await oldLogin.post("/api/v1/auth/login", { email: "rotate@example.test", password: "ShopperPassword2026!" });
  assert.equal(rejected.status, 401);
});

test("repeated failed logins are rate limited", async () => {
  const client = apiClient(ctx.baseUrl);
  let sawLimit = false;
  for (let attempt = 0; attempt < 12 && !sawLimit; attempt += 1) {
    const response = await client.post("/api/v1/auth/login", { email: "ratelimit@example.test", password: "WrongPassword2026!" });
    if (response.status === 429) {
      sawLimit = true;
      assert.equal(response.body.error.code, "RATE_LIMITED");
    } else {
      assert.equal(response.status, 401);
    }
  }
  assert.ok(sawLimit, "login attempts are rate limited per email");
});
