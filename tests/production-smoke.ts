import "dotenv/config";
import pg from "pg";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as httpsServer } from "node:https";
import { createServer as smtpServer } from "node:tls";
import { request as proxyRequest } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chromium, expect, type Browser } from "@playwright/test";
import { run } from "../scripts/backup-lib.ts";
import { createCompany } from "../scripts/setup.ts";
import { pool } from "../apps/api/src/db.ts";
if (
  !process.env.DATABASE_URL ||
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error(
    "Production smoke may write fixtures only to a separate _test database",
  );
process.umask(0o077);
const stage = await mkdtemp(path.resolve("artifacts/production-smoke-")),
  children: {
    child: ChildProcess;
    exit: Promise<number | null>;
    logs: () => string;
  }[] = [];
let web: any, api: any, proxy: any, smtp: any;
let browser: Browser | undefined;
function child(args: string[], env: NodeJS.ProcessEnv, cwd = process.cwd()) {
  const p = spawn(process.execPath, args, {
    env,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  p.stdout!.on("data", (d) => (text += d));
  p.stderr!.on("data", (d) => (text += d));
  const exit = new Promise<number | null>((resolve, reject) => {
    p.once("exit", resolve);
    p.once("error", reject);
  });
  const item = { child: p, exit, logs: () => text };
  children.push(item);
  return item;
}
async function ready(item: ReturnType<typeof child>, pattern: RegExp) {
  let timer: NodeJS.Timeout;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (pattern.test(item.logs())) resolve();
        };
        item.child.stdout!.on("data", check);
        item.child.stderr!.on("data", check);
        check();
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Server startup timed out: " + item.logs().slice(-1200),
              ),
            ),
          30000,
        );
      }),
      item.exit.then((code) => {
        throw new Error(
          "Server exited during startup " +
            code +
            ": " +
            item.logs().slice(-1200),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
try {
  await mkdir(path.join(stage, "database", "migrations"), { recursive: true });
  const keyFile = path.join(stage, "tls.key"),
    certFile = path.join(stage, "tls.pem");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyFile,
    "-out",
    certFile,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  const tls = { key: await readFile(keyFile), cert: await readFile(certFile) };
  let receive: (message: string) => void;
  const mailReceived = new Promise<string>((r) => (receive = r));
  smtp = smtpServer(tls, (socket) => {
    socket.setEncoding("utf8");
    socket.write("220 localhost Duka verification SMTP\r\n");
    let buffer = "",
      data = false,
      message: string[] = [];
    socket.on("data", (chunk) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, "");
        buffer = buffer.slice(at + 1);
        if (data) {
          if (line === ".") {
            data = false;
            receive(message.join("\r\n"));
            socket.write("250 Message accepted by local TLS sink\r\n");
          } else message.push(line.replace(/^\.\./, "."));
        } else if (/^EHLO|^HELO/.test(line))
          socket.write("250-localhost\r\n250 SIZE 1000000\r\n");
        else if (/^MAIL FROM|^RCPT TO|^RSET|^NOOP/.test(line))
          socket.write("250 OK\r\n");
        else if (line === "DATA") {
          data = true;
          message = [];
          socket.write("354 End with dot\r\n");
        } else if (line === "QUIT") {
          socket.end("221 Bye\r\n");
        } else socket.write("250 OK\r\n");
      }
    });
    socket.on("error", () => {});
  });
  smtp.listen(0, "0.0.0.0");
  await once(smtp, "listening");
  let apiPort = 4200,
    webPort = 3200;
  proxy = httpsServer(tls, (request, response) => {
    const port =
      request.url?.startsWith("/api/") || request.url?.startsWith("/health/")
        ? apiPort
        : webPort;
    const forwarded = proxyRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: request.url,
        method: request.method,
        headers: {
          ...request.headers,
          "x-forwarded-proto": "https",
          "x-forwarded-for": request.socket.remoteAddress ?? "127.0.0.1",
        },
      },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(response);
      },
    );
    forwarded.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(forwarded);
  });
  proxy.listen(0, "0.0.0.0");
  await once(proxy, "listening");
  const origin = "https://127.0.0.1:" + proxy.address().port;
  const env = {
    ...process.env,
    NODE_ENV: "production",
    DEMO_MODE: "false",
    MPESA_MODE: "disabled",
    ETIMS_MODE: "disabled",
    COOKIE_SECURE: "true",
    WEB_ORIGIN: origin,
    ALLOWED_ORIGINS: origin,
    MAIL_MODE: "smtp",
    SMTP_URL: "smtps://localhost:" + smtp.address().port,
    MAIL_FROM: "no-reply@duka.test",
    MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    TRUST_PROXY: "1",
    LOG_LEVEL: "info",
    NODE_EXTRA_CA_CERTS: certFile,
  };
  const binary = path.resolve("artifacts/server/api.mjs");
  const previewRejected = child([binary], {
    ...env,
    WORKSPACE_PREVIEW: "true",
  });
  assert.notEqual(await previewRejected.exit, 0);
  assert.match(
    previewRejected.logs(),
    /Workspace preview authentication is allowed only/,
  );
  const liveWorkspace = child([binary], {
    ...env,
    NODE_ENV: "development",
    DEMO_MODE: "true",
    WORKSPACE_PREVIEW: "true",
    MPESA_MODE: "daraja",
  });
  assert.notEqual(await liveWorkspace.exit, 0);
  assert.match(
    liveWorkspace.logs(),
    /forbids live payment and fiscal integrations/,
  );
  const rejected = child([binary], { ...env, MPESA_MODE: "mock" });
  assert.notEqual(await rejected.exit, 0);
  assert.match(rejected.logs(), /mock payments are forbidden/);
  const malformedMail = child([binary], {
    ...env,
    SMTP_URL: "smtp://PRIVATE-CONFIG-SECRET@invalid host",
  });
  assert.notEqual(await malformedMail.exit, 0);
  assert.doesNotMatch(malformedMail.logs(), /PRIVATE-CONFIG-SECRET/);
  assert.match(malformedMail.logs(), /SMTP_URL must be a valid/);
  const malformedDb = child([binary], {
    ...env,
    DATABASE_URL: "postgresql://user:PRIVATE-CONFIG-SECRET@invalid host/db",
  });
  assert.notEqual(await malformedDb.exit, 0);
  assert.doesNotMatch(malformedDb.logs(), /PRIVATE-CONFIG-SECRET/);
  const stale = child([binary], env, stage);
  assert.notEqual(await stale.exit, 0);
  assert.match(stale.logs(), /migration versions differ/);
  if (process.env.TEST_DATABASE_URL) {
    const unsafeRole = child([binary], {
      ...env,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    assert.notEqual(await unsafeRole.exit, 0);
    assert.match(unsafeRole.logs(), /non-owning runtime role|must not have/);
  }
  const role = (
    await pool.query(
      "SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,(SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tableowner=current_user) AS owned_tables FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  assert.deepEqual(role, {
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    owned_tables: 0,
  });
  if (process.env.TEST_DATABASE_URL) {
    const current = (
      await pool.query(
        "SELECT current_user AS name,has_schema_privilege(current_user,'public','CREATE') AS schema_create",
      )
    ).rows[0];
    assert.equal(current.schema_create, false);
    const owner = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await owner.connect();
    const quoted = '"' + current.name.replaceAll('"', '""') + '"';
    try {
      await owner.query(`GRANT CREATE ON SCHEMA public TO ${quoted}`);
      const unsafeSchema = child([binary], env);
      assert.notEqual(await unsafeSchema.exit, 0);
      assert.match(
        unsafeSchema.logs(),
        /must not own the database, create schema objects/,
      );
    } finally {
      await owner.query(`REVOKE CREATE ON SCHEMA public FROM ${quoted}`);
      await owner.end();
    }
  }
  const fixture = await createCompany({
    name: "Production verification fixture",
    email: randomUUID() + "@example.test",
    password: "ProdSmokeSecure-2026",
  });
  api = child([binary], { ...env, PORT: String(apiPort) });
  await ready(api, /Duka API ready/);
  web = child([path.resolve("artifacts/web/apps/web/server.js")], {
    ...env,
    PORT: String(webPort),
    HOSTNAME: "0.0.0.0",
  });
  await ready(web, /Ready in/);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage(),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const violations: unknown[] = [];
  await page.exposeFunction("__captureCsp", (v: unknown) => violations.push(v));
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as any).__captureCsp({
        directive: e.violatedDirective,
        blocked_uri: e.blockedURI.split("?")[0],
      }),
    ),
  );
  const response = await page.goto(origin);
  assert.ok(response);
  assert.equal(response.status(), 200);
  const csp = response.headers()["content-security-policy"];
  assert.match(csp, /script-src 'self' 'nonce-/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline|unsafe-eval/);
  assert.equal(response.headers()["x-powered-by"], undefined);
  await page.getByLabel("Email address").fill(fixture.actor.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill("ProdSmokeSecure-2026");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  const cookie = (await context.cookies()).find(
    (c) => c.name === "duka_session",
  );
  assert.ok(cookie?.httpOnly && cookie.secure && cookie.sameSite === "Lax");
  assert.equal(
    await page.evaluate(() => document.cookie.includes("duka_session")),
    false,
  );
  const me = await page.request.get(origin + "/api/v1/auth/me");
  assert.equal(me.status(), 200);
  assert.equal((await me.json()).data.actor.id, fixture.userId);
  const denied = await page.request.post(origin + "/api/v1/auth/logout", {
    headers: { Origin: origin },
    data: {},
  });
  assert.equal(denied.status(), 403);
  const otherCsp = (await page.request.get(origin)).headers()[
    "content-security-policy"
  ];
  assert.notEqual(otherCsp, csp);
  const reset = await page.request.post(
    origin + "/api/v1/auth/forgot-password",
    { headers: { Origin: origin }, data: { email: fixture.actor.email } },
  );
  assert.equal(reset.status(), 200);
  let mail = await mailReceived;
  const header = mail.split("\r\n\r\n")[0];
  let body = mail.slice(mail.indexOf("\r\n\r\n") + 4);
  if (/quoted-printable/i.test(header))
    body = body
      .replace(/=\r?\n/g, "")
      .replace(/=([a-f0-9]{2})/gi, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      );
  else if (/Content-Transfer-Encoding: base64/i.test(header))
    body = Buffer.from(body.replace(/\s/g, ""), "base64").toString();
  const link = body.match(/https?:\/\/\S+/)?.[0];
  assert.ok(link);
  await page.goto(link);
  await page
    .getByLabel("New password", { exact: true })
    .fill("ProdSmokeChanged-2026");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(
    page.getByRole("heading", { name: "Password updated" }),
  ).toBeVisible();
  assert.equal(
    (
      await page.request.get(origin + "/api/v1/auth/me", {
        headers: { Cookie: `duka_session=${cookie.value}` },
      })
    ).status(),
    401,
  );
  await page.goto(origin);
  await page.getByLabel("Email address").fill(fixture.actor.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill("ProdSmokeChanged-2026");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, []);
  await page.screenshot({
    path: "artifacts/verification/production-dashboard.png",
    fullPage: true,
  });
  await writeFile(
    "artifacts/verification/production-smoke.json",
    JSON.stringify(
      {
        verified: true,
        verified_at: new Date().toISOString(),
        node: process.version,
        mode: "production",
        runtime_role_non_owning: true,
        workspace_preview_mode_rejected: true,
        schema_create_rejected: !!process.env.TEST_DATABASE_URL,
        mock_mode_rejected: true,
        migration_mismatch_rejected: true,
        https_secure_http_only_cookie: true,
        csrf_rejected: true,
        nonce_csp_hydration: true,
        csp_violations: 0,
        local_verified_tls_smtp_reset: true,
        reset_revokes_old_session: true,
        live_email_delivery: false,
        live_mpesa: false,
        live_etims: false,
        public_deployment: false,
        malformed_config_credentials_not_logged: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Production standalone + bundled API: HTTPS cookies, non-owning role, nonce CSP, CSRF and local verified-TLS SMTP/reset PASS. No live provider or public deployment was tested.",
  );
} finally {
  if (browser) await browser.close();
  for (const item of children)
    if (item.child.exitCode === null && item.child.signalCode === null)
      item.child.kill("SIGTERM");
  await Promise.allSettled(children.map((c) => c.exit));
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise<void>((r) => proxy.close(() => r()));
  }
  if (smtp) await new Promise<void>((r) => smtp.close(() => r()));
  await pool.end();
  await rm(stage, { recursive: true, force: true });
}
