import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { request as forward } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { chromium, expect, type Browser } from "@playwright/test";
import { run } from "../scripts/backup-lib.ts";
// Exercise only the intentionally public isolated workspace accounts. No seeding,
// password changes or financial posting; the live API must have WORKSPACE_PREVIEW=true.
if (process.env.NODE_ENV === "production" || process.env.DEMO_MODE !== "true")
  throw new Error(
    "Workspace login smoke is restricted to isolated development/demo mode",
  );
process.umask(0o077);
await mkdir("artifacts/verification", { recursive: true });
const stage = await mkdtemp(path.resolve("artifacts/workspace-login-"));
let mainPage: any;
const consoleErrors: string[] = [];
const network: Record<string, { status?: number; failed?: string }> = {};
let browser: Browser | undefined,
  app: ReturnType<typeof createServer> | undefined,
  parent: ReturnType<typeof createServer> | undefined;
try {
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
  // A stateless real HTTPS bridge, NOT route.fetch/APIRequestContext (which could
  // hide a browser cookie bug with its own cookie jar). Alias Origin only for this
  // local dev bridge; the application's production origin policy is unchanged.
  app = createServer(tls, (req, res) => {
    const headers = {
      ...req.headers,
      host: "127.0.0.1:3000",
      "x-forwarded-proto": "https",
    };
    if (headers.origin) headers.origin = "http://localhost:3000";
    const upstream = forward(
      {
        hostname: "127.0.0.1",
        port: 3000,
        path: req.url,
        method: req.method,
        headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  app.listen(0, "0.0.0.0");
  await once(app, "listening");
  const appOrigin = "https://127.0.0.1:" + (app.address() as any).port;
  parent = createServer(tls, (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><title>Workspace embedding test</title><iframe title="Duka workspace" sandbox="allow-scripts allow-forms allow-same-origin allow-modals" style="border:0;width:100%;height:1100px" src="${appOrigin}"></iframe>`,
    );
  });
  parent.listen(0, "0.0.0.0");
  await once(parent, "listening");
  const parentOrigin = "https://localhost:" + (parent.address() as any).port;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1500, height: 1160 },
    }),
    page = await context.newPage(),
    errors: string[] = [];
  mainPage = page;
  page.on("request", (r) => {
    network[r.url()] = {};
  });
  page.on("response", (r) => {
    network[r.url()] = { status: r.status() };
  });
  page.on("requestfailed", (r) => {
    network[r.url()] = { failed: r.failure()?.errorText };
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(parentOrigin);
  const workspace = page.frameLocator("iframe");
  await workspace.getByRole("button", { name: "Use demo account" }).click();
  await expect(workspace.getByLabel("Email address")).toHaveValue(
    "owner@duka.test",
  );
  await workspace.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    workspace.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible({ timeout: 20000 });
  const session = (await context.cookies(appOrigin)).find(
    (c) => c.name === "duka_workspace_session",
  );
  assert.ok(session);
  assert.ok(session.httpOnly && session.secure);
  assert.equal(session.sameSite, "None");
  assert.ok(session.partitionKey, "CHIPS partition key must be present");
  assert.equal(new URL(session.partitionKey!).hostname, "localhost");
  const child = page.frames().find((f) => f.url().startsWith(appOrigin))!;
  assert.equal(
    await child.evaluate(() =>
      document.cookie.includes("duka_workspace_session"),
    ),
    false,
  );
  await child.goto(appOrigin, { waitUntil: "domcontentloaded" });
  await expect(
    workspace.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible({ timeout: 20000 });
  const me = await child.evaluate(async () => {
    const r = await fetch("/api/v1/auth/me", { credentials: "same-origin" });
    return r.status;
  });
  assert.equal(me, 200);
  await page.screenshot({
    path: "artifacts/verification/workspace-embedded-login.png",
    fullPage: true,
  });
  await workspace
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await expect(
    workspace.getByRole("button", { name: "Sign in to workspace" }),
  ).toBeVisible();
  assert.equal(
    (await context.cookies(appOrigin)).some(
      (c) => c.name === "duka_workspace_session",
    ),
    false,
  );
  await child.goto(appOrigin, { waitUntil: "domcontentloaded" });
  await expect(
    workspace.getByRole("button", { name: "Sign in to workspace" }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  await writeFile(
    "artifacts/verification/workspace-login.json",
    JSON.stringify(
      {
        verified: true,
        node: process.version,
        cross_site_iframe: true,
        real_browser_network: true,
        http_only: true,
        secure: true,
        same_site: "None (explicit isolated preview only)",
        partitioned: true,
        reload_retains_session: true,
        logout_clears_partitioned_cookie: true,
        no_password_changed: true,
        no_financial_posting: true,
        production_policy_changed: false,
      },
      null,
      2,
    ),
  );
  console.log(
    "Embedded workspace login/reload/logout PASS with real partitioned HttpOnly/Secure cookies; no password reset or financial posting.",
  );
} catch (error) {
  if (mainPage) {
    await mainPage
      .screenshot({
        path: "artifacts/verification/workspace-login-failure.png",
        fullPage: true,
      })
      .catch(() => {});
    await writeFile(
      "artifacts/verification/workspace-login-failure.json",
      JSON.stringify(
        {
          console_errors: consoleErrors,
          network,
          frames: await Promise.all(
            mainPage.frames().map(async (frame: any) => ({
              url: frame.url(),
              scripts: await frame
                .locator("script")
                .evaluateAll((els: any[]) =>
                  els.map((s) => ({ src: s.src, type: s.type })),
                )
                .catch(() => []),
              text: await frame
                .locator("body")
                .innerText()
                .catch(() => "unavailable"),
            })),
          ),
        },
        null,
        2,
      ),
    ).catch(() => {});
  }
  throw error;
} finally {
  if (browser) await browser.close();
  for (const server of [parent, app])
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
    }
  await rm(stage, { recursive: true, force: true });
}
