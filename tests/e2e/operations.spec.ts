import {
  test,
  expect,
  login,
  addCoffee,
  transaction,
  one,
} from "./fixtures.ts";
import {
  createDocument,
  transitionDocument,
} from "../../apps/api/src/services/business.ts";
import { verifyIntegrity } from "../../apps/api/src/services/integrity.ts";
import type { Page } from "@playwright/test";
async function cashSale(page: Page) {
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await page
    .getByRole("dialog", { name: "Complete the sale" })
    .getByRole("button", { name: "Confirm & post sale" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Sale complete" }),
  ).toBeVisible();
}
test("a paid return restores the original stock cost, refunds cash and rejects a repeated return", async ({
  page,
  workspace: f,
}) => {
  await login(page, f);
  await addCoffee(page);
  await cashSale(page);
  await page.goto("/sales");
  await page.locator(".data-table tbody tr").first().click();
  async function requestReturn() {
    await page.getByRole("button", { name: "Return / credit note" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Return goods & issue credit",
    });
    await dialog.getByLabel("Return quantity").fill("1");
    await dialog
      .getByLabel("Reason for return")
      .fill("Customer returned unopened goods");
    await dialog.getByLabel("Open cash shift").selectOption(f.shift.id);
    await dialog.getByRole("button", { name: "Post credit note" }).click();
    return dialog;
  }
  const first = await requestReturn();
  await expect(first).not.toBeVisible();
  await transaction(f.actor, async (ctx) => {
    expect(
      await one(
        ctx,
        "SELECT quantity,value FROM stock_balances WHERE company_id=$1 AND product_id=$2",
        [f.companyId, f.product.id],
      ),
    ).toMatchObject({ quantity: "20.000000", value: "1000.000000" });
    expect(
      (
        await one(
          ctx,
          "SELECT coalesce(sum(CASE WHEN direction='in' THEN amount ELSE -amount END),0)::text AS n FROM payments WHERE company_id=$1",
          [f.companyId],
        )
      ).n,
    ).toBe("0.00");
    expect((await verifyIntegrity(ctx)).matches).toBe(true);
  });
  const duplicate = await requestReturn();
  await expect(duplicate.getByRole("alert")).toContainText(
    /exceed|already|unreturned/i,
  );
  await transaction(f.actor, async (ctx) =>
    expect(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM sale_returns WHERE company_id=$1",
          [f.companyId],
        )
      ).n,
    ).toBe(1),
  );
});
test("approved reserved order loads into POS, survives reload and is fulfilled once", async ({
  page,
  workspace: f,
}) => {
  const order = await transaction(f.actor, async (ctx) => {
    const o = await createDocument(ctx, {
      kind: "sales_order",
      branch_id: f.branchId,
      warehouse_id: f.warehouseId,
      lines: [{ product_id: f.product.id, quantity: "1" }],
    });
    await transitionDocument(ctx, o.id, "submitted", "Browser order submitted");
    await transitionDocument(
      ctx,
      o.id,
      "approved",
      "Explicit owner approval for browser order",
    );
    return o;
  });
  await login(page, f);
  await page.goto("/pos?order=" + order.id);
  await expect(
    page.getByText(
      `Fulfilling ${order.number}. Approved quantities are fixed.`,
    ),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText(
      `Fulfilling ${order.number}. Approved quantities are fixed.`,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Increase Browser test coffee" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Continue to payment" }),
  ).toBeEnabled();
  await cashSale(page);
  await transaction(f.actor, async (ctx) => {
    expect(
      (
        await one(
          ctx,
          "SELECT status,sale_id FROM business_documents WHERE company_id=$1 AND id=$2",
          [f.companyId, order.id],
        )
      ).status,
    ).toBe("converted");
    expect(
      await one(
        ctx,
        "SELECT quantity,reserved FROM stock_balances WHERE company_id=$1 AND product_id=$2",
        [f.companyId, f.product.id],
      ),
    ).toMatchObject({ quantity: "19.000000", reserved: "0.000000" });
    expect((await verifyIntegrity(ctx)).matches).toBe(true);
  });
});
test("an expense and receipt survive a lost commit response; unchanged resubmission after reload reuses its key", async ({
  page,
  workspace: f,
}) => {
  await login(page, f);
  await page.goto("/expenses");
  const keys: string[] = [];
  let drop = true,
    limited = false;
  await page.route("**/api/v1/expenses", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (drop) {
      drop = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    } else if (!limited) {
      limited = true;
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "RATE_LIMITED",
            message: "Temporary verification rate limit",
          },
        }),
      });
    } else await route.continue();
  });
  async function fill() {
    await page
      .getByRole("button", { name: "Expense request", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Request an expense" });
    await dialog.getByLabel("Net amount (excluding tax)").fill("100");
    await dialog
      .getByLabel("Business purpose / description")
      .fill("Browser atomic receipt and recovery test");
    await dialog.getByLabel("Receipt attachment").setInputFiles({
      name: "browser-receipt.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await dialog
      .getByRole("button", { name: "Submit expense request" })
      .click();
    return dialog;
  }
  let dialog = await fill();
  await expect(dialog.getByRole("alert")).toContainText("Response unconfirmed");
  await page.reload();
  dialog = await fill();
  await expect(dialog.getByRole("alert")).toContainText(
    "Temporary verification rate limit",
  );
  await dialog.getByRole("button", { name: "Submit expense request" }).click();
  await expect(dialog).not.toBeVisible();
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  await page.locator(".data-table tbody tr").first().click();
  await expect(
    page.getByRole("link", { name: "Receipt: browser-receipt.png" }),
  ).toBeVisible();
  await transaction(f.actor, async (ctx) => {
    expect(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM expenses WHERE company_id=$1",
          [f.companyId],
        )
      ).n,
    ).toBe(1);
    expect(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM attachments WHERE company_id=$1 AND entity='expense'",
          [f.companyId],
        )
      ).n,
    ).toBe(1);
    expect((await verifyIntegrity(ctx)).matches).toBe(true);
  });
});
test("390px mobile navigation and cash checkout remain usable without document overflow", async ({
  page,
  workspace: f,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, f);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Point of sale ↗" })
    .click();
  await expect(page).toHaveURL(/\/pos/);
  await addCoffee(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/verification/mobile-pos.png",
    fullPage: true,
  });
  await cashSale(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await transaction(f.actor, async (ctx) =>
    expect((await verifyIntegrity(ctx)).matches).toBe(true),
  );
});

test("paid supplier credit can be allocated, reversed and actually refunded through the connected invoice UI", async ({
  page,
  workspace: f,
}) => {
  const {
    createPurchaseOrder,
    transitionPurchaseOrder,
    receiveGoods,
    recognizeSupplierInvoice,
    returnSupplierGoods,
  } = await import("../../apps/api/src/services/procurement.ts");
  const { settleContact } = await import(
    "../../apps/api/src/services/payments.ts"
  );
  const { postJournal } = await import("@duka/accounting");
  const invoices = await transaction(f.actor, async (ctx) => {
    await postJournal(ctx, {
      branchId: f.branchId,
      date: new Date().toISOString().slice(0, 10),
      sourceType: "opening",
      sourceId: crypto.randomUUID(),
      description: "Browser supplier credit funding",
      lines: [
        { account: "bank", debit: "1000" },
        { account: "cash", debit: "500" },
        { account: "equity", credit: "1500" },
      ],
    });
    const result = [];
    for (let i = 0; i < 2; i++) {
      const po = await createPurchaseOrder(ctx, {
        supplier_id: f.supplier.id,
        warehouse_id: f.warehouseId,
        lines: [{ product_id: f.product.id, quantity: "2", unit_cost: "50" }],
      });
      await transitionPurchaseOrder(
        ctx,
        po.id,
        "submitted",
        "Browser supplier credit order",
      );
      await transitionPurchaseOrder(
        ctx,
        po.id,
        "approved",
        "Explicit browser fixture approval",
      );
      const grn = await receiveGoods(ctx, {
        order_id: po.id,
        lines: [
          {
            order_line_id: po.lines[0].id,
            quantity: "2",
            rejected_quantity: "0",
            serials: [],
          },
        ],
      });
      const line = await one(
        ctx,
        "SELECT id FROM goods_receipt_lines WHERE company_id=$1 AND receipt_id=$2",
        [f.companyId, grn.id],
      );
      const invoice = await recognizeSupplierInvoice(ctx, {
        receipt_id: grn.id,
        supplier_reference: `BROWSER-CREDIT-${i}`,
        due_date: new Date().toISOString().slice(0, 10),
        lines: [
          { receipt_line_id: line.id, net: "100", tax_rule_id: f.tax.id },
        ],
      });
      result.push({ ...invoice, line: line.id });
    }
    await settleContact(ctx, "supplier", {
      branch_id: f.branchId,
      contact_id: f.supplier.id,
      payment: {
        method_id: f.bank.id,
        amount: "116",
        reference: "BROWSER-CREDIT-PAID",
      },
      allocations: [{ document_id: result[0].id, amount: "116" }],
    });
    await returnSupplierGoods(ctx, {
      invoice_id: result[0].id,
      reason: "Full return of paid supplier goods",
      lines: [{ receipt_line_id: result[0].line, quantity: "2" }],
    });
    return result;
  });
  await login(page, f);
  await page.goto("/purchasing");
  await page
    .getByRole("button", { name: "Supplier invoices", exact: true })
    .click();
  await page
    .locator(".data-table tbody tr")
    .filter({ hasText: invoices[0].number })
    .click();
  await page
    .getByRole("button", { name: "Settle supplier credit", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Settle supplier credit",
    exact: true,
  });
  await dialog.getByLabel("Credit amount").fill("40");
  await dialog
    .getByLabel("Target supplier invoice")
    .selectOption(invoices[1].id);
  await dialog
    .getByLabel("Credit settlement reason")
    .fill("Apply paid supplier return credit to another invoice");
  let posted = page.waitForResponse(
    (r) => r.url().endsWith("/purchases/credits/settle") && r.status() === 200,
  );
  await dialog
    .getByRole("button", { name: "Post supplier credit settlement" })
    .click();
  let result = (await (await posted).json()).data;
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Reverse " + result.number, exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Reverse supplier credit settlement",
    exact: true,
  });
  await dialog
    .getByLabel("Credit settlement reason")
    .fill("Correct allocation through controlled reversal");
  posted = page.waitForResponse(
    (r) =>
      r.url().includes("/credits/" + result.id + "/reverse") &&
      r.status() === 200,
  );
  await dialog
    .getByRole("button", { name: "Post credit settlement reversal" })
    .click();
  await posted;
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Settle supplier credit", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Settle supplier credit",
    exact: true,
  });
  await dialog.getByLabel("Credit settlement type").selectOption("refund");
  await dialog.getByLabel("Credit amount").fill("50");
  await dialog.getByLabel("Actual refund method").selectOption(f.bank.id);
  await dialog
    .getByLabel("Confirmed transfer reference")
    .fill("BROWSER-ACTUAL-CREDIT-REFUND");
  await dialog
    .getByLabel("Credit settlement reason")
    .fill("Actual supplier refund confirmed against bank statement");
  posted = page.waitForResponse(
    (r) => r.url().endsWith("/purchases/credits/settle") && r.status() === 200,
  );
  await dialog
    .getByRole("button", { name: "Post supplier credit settlement" })
    .click();
  await posted;
  await expect(dialog).not.toBeVisible();
  const current = await page.request.get(
    "/api/v1/purchases/invoices/" + invoices[0].id,
  );
  expect((await current.json()).data.outstanding).toBe("-66.00");
  const items = await page.request.get(
    "/api/v1/suppliers/" +
      f.supplier.id +
      "/open-items?branch_id=" +
      f.branchId,
  );
  const open = (await items.json()).data;
  expect(open.total).toBe(1);
  expect(open.items[0].id).toBe(invoices[1].id);
  await transaction(f.actor, async (ctx) =>
    expect((await verifyIntegrity(ctx)).matches).toBe(true),
  );
});

test("stock count snapshots are invalidated on warehouse/type changes and late responses cannot restore the old scope", async ({
  page,
  workspace: f,
}) => {
  const { postStockDocument } = await import(
    "../../apps/api/src/services/inventory.ts"
  );
  const stores = await transaction(f.actor, async (ctx) => {
    const primary = await one(
      ctx,
      "SELECT name FROM warehouses WHERE company_id=$1 AND id=$2",
      [f.companyId, f.warehouseId],
    );
    const secondary = await one(
      ctx,
      "INSERT INTO warehouses(company_id,branch_id,name,code) VALUES($1,$2,'Second count store','COUNT2') RETURNING id",
      [f.companyId, f.branchId],
    );
    await ctx.db.query(
      "INSERT INTO user_warehouses(company_id,user_id,warehouse_id) VALUES($1,$2,$3)",
      [f.companyId, f.actor.id, secondary.id],
    );
    f.actor.warehouse_ids.push(secondary.id);
    await postStockDocument(ctx, {
      type: "opening",
      warehouse_id: secondary.id,
      reason: "Independent count warehouse opening",
      lines: [{ product_id: f.product.id, quantity: "5", unit_cost: "50" }],
    });
    return { primary: primary.name, secondary: secondary.id };
  });
  await login(page, f);
  await page.goto("/inventory");
  await page
    .locator(".data-table tbody tr")
    .filter({ hasText: stores.primary })
    .getByRole("button", { name: "Count Browser test coffee" })
    .click();
  const dialog = page.locator("dialog[open]");
  const post = dialog.getByRole("button", {
    name: "Post stock document",
    exact: true,
  });
  await expect(dialog.locator(".snapshot-note")).toContainText(/system\s+20/);
  await expect(post).toBeEnabled();
  await dialog
    .getByRole("combobox", { name: "Warehouse", exact: true })
    .selectOption(stores.secondary);
  await expect(dialog.locator(".snapshot-note")).toContainText("not captured");
  await expect(post).toBeDisabled();
  await dialog
    .getByRole("combobox", { name: "Document type", exact: true })
    .selectOption("adjustment");
  await dialog
    .getByRole("combobox", { name: "Document type", exact: true })
    .selectOption("count");
  await expect(post).toBeDisabled();
  let signal!: () => void, release!: () => void;
  const requested = new Promise<void>((r) => (signal = r)),
    held = new Promise<void>((r) => (release = r));
  await page.route(
    "**/api/v1/inventory/balances?**",
    async (route) => {
      const response = await route.fetch();
      signal();
      await held;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await dialog
    .getByRole("button", { name: "Load current system quantities" })
    .click();
  await requested;
  await dialog
    .getByRole("combobox", { name: "Warehouse", exact: true })
    .selectOption(f.warehouseId);
  const response = page.waitForResponse(
    (r) => r.url().includes("/inventory/balances?") && r.status() === 200,
  );
  release();
  await response;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(dialog.locator(".snapshot-note")).toContainText("not captured");
  await expect(post).toBeDisabled();
  await dialog
    .getByRole("combobox", { name: "Warehouse", exact: true })
    .selectOption(stores.secondary);
  await dialog
    .getByRole("button", { name: "Load current system quantities" })
    .click();
  await expect(dialog.locator(".snapshot-note")).toContainText(/system\s+5/);
  await dialog.getByLabel("Quantity for Browser test coffee").fill("4");
  await expect(post).toBeEnabled();
  const posted = page.waitForResponse(
    (r) => r.url().endsWith("/inventory/documents") && r.status() === 200,
  );
  await post.click();
  await posted;
  await expect(dialog).not.toBeVisible();
  await transaction(f.actor, async (ctx) => {
    expect(
      (
        await one(
          ctx,
          "SELECT quantity FROM stock_balances WHERE company_id=$1 AND product_id=$2 AND warehouse_id=$3",
          [f.companyId, f.product.id, f.warehouseId],
        )
      ).quantity,
    ).toBe("20.000000");
    expect(
      (
        await one(
          ctx,
          "SELECT quantity FROM stock_balances WHERE company_id=$1 AND product_id=$2 AND warehouse_id=$3",
          [f.companyId, f.product.id, stores.secondary],
        )
      ).quantity,
    ).toBe("4.000000");
    expect((await verifyIntegrity(ctx)).matches).toBe(true);
  });
});

test("authoritative recovery cancels only an unposted checkout, rejects its delayed packet and permits a distinct corrected intention", async ({
  page,
  workspace: f,
}) => {
  await login(page, f);
  await addCoffee(page);
  await page.getByRole("button", { name: "Continue to payment" }).click();
  let original: any;
  await page.route(
    "**/api/v1/sales",
    async (route) => {
      original = {
        body: route.request().postDataJSON(),
        headers: route.request().headers(),
      };
      await route.abort("failed");
    },
    { times: 1 },
  );
  const payment = page.getByRole("dialog", { name: "Complete the sale" });
  await payment.getByRole("button", { name: "Confirm & post sale" }).click();
  await expect(payment.getByRole("alert")).toContainText(
    "Response unconfirmed",
  );
  await payment.getByRole("button", { name: "Close dialog" }).click();
  page.once("dialog", (d) => d.accept());
  const cancelled = page.waitForResponse(
    (r) => r.url().endsWith("/sales/recovery/cancel") && r.status() === 200,
  );
  await page
    .getByRole("button", { name: "Recover or cancel unposted" })
    .click();
  expect((await (await cancelled).json()).data.status).toBe("cancelled");
  await expect(
    page.getByRole("button", { name: "Review & retry" }),
  ).not.toBeVisible();
  const late = await page.request.post("/api/v1/sales", {
    headers: {
      Origin: "http://127.0.0.1:3100",
      "X-CSRF-Token": original.headers["x-csrf-token"],
      "Idempotency-Key": original.headers["idempotency-key"],
    },
    data: original.body,
  });
  expect(late.status()).toBe(409);
  expect((await late.json()).error.code).toBe("COMMAND_CANCELLED");
  await transaction(f.actor, async (ctx) =>
    expect(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM sales WHERE company_id=$1",
          [f.companyId],
        )
      ).n,
    ).toBe(0),
  );
  await cashSale(page);
  await transaction(f.actor, async (ctx) => {
    expect(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM sales WHERE company_id=$1",
          [f.companyId],
        )
      ).n,
    ).toBe(1);
    expect((await verifyIntegrity(ctx)).matches).toBe(true);
  });
});

test("a missing browser session gives actionable login guidance instead of silently staying at sign-in", async ({
  page,
  workspace: f,
}) => {
  await page.route(
    "**/api/v1/auth/login",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { csrf_token: "synthetic-cookie-not-retained-ui-probe" },
        }),
      }),
    { times: 1 },
  );
  await page.goto("/");
  await page.getByLabel("Email address").fill(f.actor.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill("BrowserSecurePass-2026");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Sign-in could not restore a usable session" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).not.toBeVisible();
});

test("paid expense refund, confirmed repayment and exact final refund use the connected voucher UI without editing source history", async ({
  page,
  workspace: f,
}) => {
  const { createExpense, reviewExpense, payExpense } = await import(
    "../../apps/api/src/services/business.ts"
  );
  const { postJournal } = await import("@duka/accounting");
  const expense = await transaction(f.actor, async (ctx) => {
    await postJournal(ctx, {
      branchId: f.branchId,
      date: new Date().toISOString().slice(0, 10),
      sourceType: "opening",
      sourceId: crypto.randomUUID(),
      description: "Browser expense refund bank and existing drawer funding",
      lines: [
        { account: "bank", debit: "1000" },
        { account: "cash", debit: "500" },
        { account: "equity", credit: "1500" },
      ],
    });
    const category = await one(
      ctx,
      "SELECT id FROM expense_categories WHERE company_id=$1 LIMIT 1",
      [f.companyId],
    );
    const e = await createExpense(ctx, {
      branch_id: f.branchId,
      category_id: category.id,
      tax_rule_id: f.tax.id,
      net: "100",
      description: "Browser refundable paid voucher",
    });
    await reviewExpense(
      ctx,
      e.id,
      "approved",
      "Explicit owner approval in the isolated browser fixture",
    );
    await payExpense(ctx, e.id, {
      payment: {
        method_id: f.bank.id,
        amount: "116",
        reference: "BROWSER-EXPENSE-PAID",
      },
    });
    return e;
  });
  await login(page, f);
  await page.goto("/expenses");
  await page
    .locator(".data-table tbody tr")
    .filter({ hasText: expense.number })
    .click();
  let command: any;
  page.on("request", (request) => {
    if (
      request.url().endsWith(`/expenses/${expense.id}/refunds`) &&
      request.method() === "POST" &&
      !command
    )
      command = { body: request.postDataJSON(), headers: request.headers() };
  });
  async function refund(amount: string, reference: string) {
    await page
      .getByRole("button", { name: "Record expense refund", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Record actual expense refund",
      exact: true,
    });
    await dialog.getByLabel("Actual refund amount").fill(amount);
    await dialog.getByLabel("Refund received by").selectOption(f.bank.id);
    await dialog
      .getByLabel("Confirmed expense transfer reference")
      .fill(reference);
    await dialog
      .getByLabel("Expense refund or repayment reason")
      .fill("Actual supplier refund independently matched to bank statement");
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/expenses/${expense.id}/refunds`) &&
        r.status() === 200,
    );
    await dialog
      .getByRole("button", { name: "Post expense refund received" })
      .click();
    const result = (await (await response).json()).data;
    await expect(dialog).not.toBeVisible();
    return result;
  }
  const first = await refund("30.25", "BROWSER-EXPENSE-REFUND1");
  expect(first.net).toBe("26.08");
  expect(first.tax).toBe("4.17");
  await page
    .getByRole("button", { name: "Repay " + first.number, exact: true })
    .click();
  const repayment = page.getByRole("dialog", {
    name: "Repay an expense refund",
    exact: true,
  });
  await repayment.getByLabel("Repayment tender").selectOption(f.bank.id);
  await repayment
    .getByLabel("Confirmed expense transfer reference")
    .fill("BROWSER-EXPENSE-REPAID");
  await repayment
    .getByLabel("Expense refund or repayment reason")
    .fill("Actual bank repayment of the original partial refund");
  const reversed = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/expenses/refunds/${first.id}/reverse`) &&
      r.status() === 200,
  );
  await repayment
    .getByRole("button", { name: "Post actual refund repayment" })
    .click();
  await reversed;
  await expect(repayment).not.toBeVisible();
  await refund("116", "BROWSER-EXPENSE-REFUND-FULL");
  const replay = await page.request.post(
    `/api/v1/expenses/${expense.id}/refunds`,
    {
      headers: {
        Origin: "http://127.0.0.1:3100",
        "X-CSRF-Token": command.headers["x-csrf-token"],
        "Idempotency-Key": command.headers["idempotency-key"],
      },
      data: command.body,
    },
  );
  expect(replay.status()).toBe(200);
  expect((await replay.json()).data.id).toBe(first.id);
  const detail = (
    await (await page.request.get(`/api/v1/expenses/${expense.id}`)).json()
  ).data;
  expect(detail.status).toBe("posted");
  expect(detail.net).toBe("100.00");
  expect(detail.tax).toBe("16.00");
  expect(detail.remaining).toBe("0.00");
  expect(detail.refunds).toHaveLength(3);
  const pdf = await page.request.get(
    "/api/v1/print/expense-refund/" + first.id,
  );
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  await transaction(f.actor, async (ctx) =>
    expect((await verifyIntegrity(ctx)).matches).toBe(true),
  );
});

test("guided opening AR/AP imports are reviewed, settle through real contact allocation and consume booked credit without fake turnover", async ({
  page,
  workspace: f,
}) => {
  const { saveContact } = await import(
    "../../apps/api/src/services/catalog.ts"
  );
  const { customerSchema } = await import("@duka/shared");
  const { postJournal } = await import("@duka/accounting");
  const { settleContact } = await import(
    "../../apps/api/src/services/payments.ts"
  );
  const setup = await transaction(f.actor, async (ctx) => {
    const dates = await one(
      ctx,
      "SELECT to_char(now() AT TIME ZONE timezone,'YYYY-MM-DD') AS today,((now() AT TIME ZONE timezone)::date-1)::text AS cutover FROM companies WHERE id=$1",
      [f.companyId],
    );
    await postJournal(ctx, {
      branchId: f.branchId,
      date: dates.today,
      sourceType: "opening",
      sourceId: crypto.randomUUID(),
      description: "Explicit existing bank cash before onboarding legacy debt",
      lines: [
        { account: "bank", debit: "1000" },
        { account: "equity", credit: "1000" },
      ],
    });
    const customer = await saveContact(
      ctx,
      "customer",
      customerSchema.parse({
        name: "Migrated customer",
        code: "MIG-C",
        credit_limit: "1000",
      }),
    );
    return { ...dates, customer };
  });
  await login(page, f);
  await page.goto("/accounting");
  await page
    .getByRole("button", { name: "Opening balances", exact: true })
    .click();
  await page.getByRole("button", { name: "Import opening AR/AP" }).click();
  let dialog = page.getByRole("dialog", {
    name: "Prepare opening AR/AP migration",
  });
  await dialog.getByLabel("Opening cutover date").fill(setup.cutover);
  await dialog
    .getByLabel("Source ledger reference")
    .fill("Reconciled old-system closing ledger");
  async function row(
    index: number,
    kind: string,
    code: string,
    reference: string,
    amount: string,
  ) {
    await dialog
      .getByRole("combobox", { name: "Opening ledger " + index, exact: true })
      .selectOption(kind);
    await dialog
      .getByLabel("Contact account code " + index, { exact: true })
      .fill(code);
    await dialog
      .getByLabel("Legacy document reference " + index, { exact: true })
      .fill(reference);
    await dialog
      .getByLabel("Original document date " + index, { exact: true })
      .fill("2025-01-01");
    await dialog
      .getByLabel("Original due date " + index, { exact: true })
      .fill("2025-02-01");
    await dialog
      .getByLabel("Outstanding legacy amount " + index, { exact: true })
      .fill(amount);
  }
  await row(1, "customer", "MIG-C", "CUST-LEGACY-1", "600");
  await dialog.getByRole("button", { name: "Add legacy debt row" }).click();
  await row(2, "supplier", f.supplier.code, "SUP-LEGACY-1", "400");
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/accounting/opening-batches") &&
      r.request().method() === "POST" &&
      r.status() === 200,
  );
  await dialog
    .getByRole("button", { name: "Save unposted opening draft" })
    .click();
  const batch = (await (await saved).json()).data;
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Submit opening batch", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Opening draft workflow" });
  await dialog
    .getByLabel("Opening workflow reason")
    .fill(
      "Reviewed original outstanding amounts and prior-system reconciliation",
    );
  await dialog
    .getByRole("button", { name: "Confirm opening submitted" })
    .click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Approve & post opening balances" })
    .click();
  dialog = page.getByRole("dialog", { name: "Approve opening carry-forward" });
  await dialog
    .getByLabel("Opening workflow reason")
    .fill("Explicit owner approval under the isolated test policy");
  await dialog.getByRole("checkbox").check();
  const posted = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/opening-batches/${batch.id}/post`) &&
      r.status() === 200,
  );
  await dialog.getByRole("button", { name: "Confirm opening post" }).click();
  await posted;
  await expect(dialog).not.toBeVisible();
  await transaction(f.actor, async (ctx) => {
    for (const table of ["sales", "supplier_invoices", "payments"])
      expect(
        (
          await one(
            ctx,
            `SELECT count(*)::int AS n FROM ${table} WHERE company_id=$1`,
            [f.companyId],
          )
        ).n,
      ).toBe(0);
    expect((await verifyIntegrity(ctx)).matches).toBe(true);
  });
  await page.goto("/customers");
  await page
    .getByRole("button", {
      name: "Statement for Migrated customer",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Receive payment", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Receive customer payment" });
  await dialog
    .getByRole("combobox", { name: "Payment method", exact: true })
    .selectOption(f.bank.id);
  await dialog.getByLabel("Total payment amount").fill("200");
  await dialog
    .getByLabel("Confirmed payment reference")
    .fill("OPENING-CUSTOMER-RECEIPT");
  await dialog
    .getByLabel("Allocation to " + batch.number + " · CUST-LEGACY-1", {
      exact: true,
    })
    .fill("200");
  const received = page.waitForResponse(
    (r) => r.url().endsWith("/customers/settlements") && r.status() === 200,
  );
  await dialog
    .getByRole("button", { name: "Post receipt", exact: false })
    .click();
  await received;
  await expect(dialog).not.toBeVisible();
  await page.goto("/suppliers");
  await page
    .getByRole("button", {
      name: "Statement for " + f.supplier.name,
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Pay supplier", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Pay supplier", exact: true });
  await dialog
    .getByRole("combobox", { name: "Payment method", exact: true })
    .selectOption(f.bank.id);
  await dialog.getByLabel("Total payment amount").fill("150");
  await dialog
    .getByLabel("Confirmed payment reference")
    .fill("OPENING-SUPPLIER-PAYMENT");
  await dialog
    .getByLabel("Allocation to " + batch.number + " · SUP-LEGACY-1", {
      exact: true,
    })
    .fill("150");
  const paid = page.waitForResponse(
    (r) => r.url().endsWith("/suppliers/settlements") && r.status() === 200,
  );
  await dialog
    .getByRole("button", { name: "Post payment", exact: false })
    .click();
  await paid;
  await expect(dialog).not.toBeVisible();
  const credit = await transaction(f.actor, async (ctx) => {
    const r = await settleContact(ctx, "customer", {
      branch_id: f.branchId,
      contact_id: setup.customer.id,
      payment: {
        method_id: f.bank.id,
        amount: "100",
        reference: "OPENING-BOOKED-CREDIT",
      },
      allocations: [],
    });
    return one(
      ctx,
      "SELECT id FROM advance_credits WHERE company_id=$1 AND source_id=$2",
      [f.companyId, r.id],
    );
  });
  await page.goto("/accounting");
  await page
    .getByRole("button", { name: "Opening balances", exact: true })
    .click();
  await page
    .locator(".data-table tbody tr")
    .filter({ hasText: batch.number })
    .click();
  await page
    .getByRole("button", {
      name: "Apply booked credit to CUST-LEGACY-1",
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Apply booked credit to opening debt",
  });
  await dialog.getByLabel("Available booked credit").selectOption(credit.id);
  await dialog.getByLabel("Opening credit allocation amount").fill("50");
  await dialog
    .getByLabel("Opening credit allocation reason")
    .fill("Use an already recognized customer advance against old debt");
  const allocated = page.waitForResponse(
    (r) =>
      r.url().includes("/accounting/opening-items/") &&
      r.url().endsWith("/apply-credit") &&
      r.status() === 200,
  );
  await dialog.getByRole("button", { name: "Apply existing credit" }).click();
  await allocated;
  await expect(dialog).not.toBeVisible();
  const detail = (
    await (
      await page.request.get("/api/v1/accounting/opening-batches/" + batch.id)
    ).json()
  ).data;
  expect(detail.items.find((i: any) => i.kind === "customer").outstanding).toBe(
    "350.00",
  );
  expect(detail.items.find((i: any) => i.kind === "supplier").outstanding).toBe(
    "250.00",
  );
  const pdf = await page.request.get(
    "/api/v1/print/opening-balance/" + batch.id,
  );
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  await transaction(f.actor, async (ctx) =>
    expect((await verifyIntegrity(ctx)).matches).toBe(true),
  );
});
