import { test as base, expect, type Page } from "@playwright/test";
import "dotenv/config";
if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Refusing E2E fixture writes outside a _test database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ETIMS_MODE = "disabled";
process.env.MPESA_MODE = "mock";
const { transaction, one, pool, digest } = await import(
  "../../apps/api/src/db.ts"
);
if (
  pool.options.connectionString !== process.env.TEST_DATABASE_URL ||
  (await pool.query("SELECT current_database() AS name")).rows[0].name !==
    decodeURIComponent(new URL(process.env.TEST_DATABASE_URL).pathname.slice(1))
)
  throw new Error(
    "Refusing E2E: application pool selected a different physical database",
  );
const { createCompany } = await import("../../scripts/setup.ts");
const { productSchema, supplierSchema } = await import("@duka/shared");
const { createProduct, saveContact } = await import(
  "../../apps/api/src/services/catalog.ts"
);
const { postStockDocument } = await import(
  "../../apps/api/src/services/inventory.ts"
);
const { openShift } = await import("../../apps/api/src/services/shifts.ts");
const { randomUUID } = await import("node:crypto");
export { expect, transaction, one, pool };
async function prepare() {
  // Only the dedicated _test DB: isolate repeat runs from a shared localhost rate bucket.
  await pool.query("DELETE FROM rate_limit_buckets WHERE key=ANY($1::text[])", [
    ["login:ip:127.0.0.1", "login:ip:::ffff:127.0.0.1"].map(digest),
  ]);
  const f = await createCompany({
    name: "E2E isolated shop",
    email: `e2e-${randomUUID()}@example.test`,
    password: "BrowserSecurePass-2026",
  });
  return transaction(f.actor, async (ctx) => {
    await ctx.db.query(
      `UPDATE companies SET settings=settings||'{"allowSelfApproval":true}'::jsonb WHERE id=$1`,
      [f.companyId],
    );
    const unit = await one(
      ctx,
      "SELECT id FROM units WHERE company_id=$1 AND symbol='pc'",
      [f.companyId],
    );
    const tax = await one(
      ctx,
      "SELECT id FROM tax_rules WHERE company_id=$1 AND code='VAT16'",
      [f.companyId],
    );
    const product = await createProduct(
      ctx,
      productSchema.parse({
        name: "Browser test coffee",
        sku: "BROWSER-COFFEE",
        price: "116",
        purchase_cost: "50",
        unit_id: unit.id,
        tax_rule_id: tax.id,
      }),
    );
    await postStockDocument(ctx, {
      type: "opening",
      warehouse_id: f.warehouseId,
      reason: "Verified E2E opening stock",
      lines: [{ product_id: product.id, quantity: "20", unit_cost: "50" }],
    });
    const supplier = await saveContact(
      ctx,
      "supplier",
      supplierSchema.parse({
        name: "Browser test supplier",
        code: "BROWSER-SUP",
      }),
    );
    const shift = await openShift(ctx, {
      register_id: f.registerId,
      opening_float: "500",
    });
    const methods = (
      await ctx.db.query("SELECT * FROM payment_methods WHERE company_id=$1", [
        f.companyId,
      ])
    ).rows;
    return {
      ...f,
      product,
      supplier,
      shift,
      tax,
      cash: methods.find((m) => m.kind === "cash"),
      bank: methods.find((m) => m.kind === "bank"),
      mpesa: methods.find((m) => m.kind === "mpesa"),
    };
  });
}
export type Workspace = Awaited<ReturnType<typeof prepare>>;
export const test = base.extend<{ workspace: Workspace; browserErrors: void }>({
  browserErrors: [
    async ({ page, context }, use) => {
      const errors: string[] = [],
        violations: unknown[] = [];
      const observe = (tab: Page) =>
        tab.on("pageerror", (error) => errors.push(error.message));
      context.pages().forEach(observe);
      context.on("page", observe);
      await context.exposeBinding("__dukaCspViolation", (_source, value) =>
        violations.push(value),
      );
      await context.addInitScript(() =>
        document.addEventListener("securitypolicyviolation", (event) =>
          (window as any).__dukaCspViolation({
            directive: event.violatedDirective,
            blocked_uri: event.blockedURI.split("?")[0],
          }),
        ),
      );
      await use();
      expect(errors).toEqual([]);
      expect(violations).toEqual([]);
    },
    { auto: true },
  ],
  workspace: async ({}, use) => {
    const f = await prepare();
    await use(f);
  },
});
export async function login(page: Page, f: Workspace) {
  await page.goto("/");
  await page.getByLabel("Email address").fill(f.actor.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill("BrowserSecurePass-2026");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
}
export async function addCoffee(page: Page) {
  await page.goto("/pos");
  const priced = page.waitForResponse(
    (r) => r.url().includes("/pos/price") && r.status() === 200,
  );
  await page
    .getByRole("button")
    .filter({ has: page.getByText("Browser test coffee", { exact: true }) })
    .click();
  await expect(
    page
      .locator(".cart-lines")
      .getByText("Browser test coffee", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => page.locator(".cart-grand-total").innerText())
    .toContain("116");
  await priced;
}
export async function pick(page: Page, label: string, name: string) {
  await page.getByRole("combobox", { name: label, exact: true }).fill(name);
  await page.getByRole("option").filter({ hasText: name }).click();
}
