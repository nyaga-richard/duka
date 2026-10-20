import { D } from "@duka/shared";
import {
  test,
  expect,
  login,
  addCoffee,
  pick,
  transaction,
  one,
  type Workspace,
} from "./fixtures.ts";
import type { Page } from "@playwright/test";
async function posted(page: Page) {
  await expect(
    page.getByRole("dialog", { name: "Sale complete" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Sale complete" }),
  ).toContainText("Not a KRA fiscal invoice");
}
async function assertEffects(f: Workspace, cash = "116", count = 1) {
  await transaction(f.actor, async (ctx) => {
    assertEqual(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM sales WHERE company_id=$1",
          [f.companyId],
        )
      ).n,
      count,
    );
    const stock = await one(
      ctx,
      "SELECT quantity FROM stock_balances WHERE company_id=$1 AND product_id=$2",
      [f.companyId, f.product.id],
    );
    assertEqual(stock.quantity, (20 - count).toFixed(6));
    const cashMovement = await one(
      ctx,
      "SELECT coalesce(sum(p.amount),0)::text AS amount FROM payments p JOIN payment_methods m ON m.company_id=p.company_id AND m.id=p.method_id WHERE p.company_id=$1 AND p.source_type='sale' AND m.kind='cash'",
      [f.companyId],
    );
    expect(D(cashMovement.amount).eq(cash)).toBe(true);
    const r = await ctx.db.query(
      "SELECT sum(l.debit-l.credit)::text AS difference FROM journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=$1 AND j.source_type='sale'",
      [f.companyId],
    );
    expect(r.rows[0].difference).toBe("0.00");
  });
}
function assertEqual(a: any, b: any) {
  expect(a).toBe(b);
}
test("cash + bank split checkout posts once and unchanged lost-response retry returns the same sale", async ({
  page,
  workspace: f,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, f);
  await addCoffee(page);
  await page.getByRole("button", { name: "Continue to payment" }).click();
  const dialog = page.getByRole("dialog", { name: "Complete the sale" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Applied amount").fill("60");
  await dialog.getByRole("button", { name: "Split payment" }).click();
  await dialog.getByLabel("Confirmed payment reference").fill("E2E-BANK-001");
  await expect(dialog).toContainText("Payment balanced");
  let command: any;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/v1/sales") && req.method() === "POST")
      command = { body: req.postDataJSON(), headers: req.headers() };
  });
  const keys: string[] = [];
  let dropped = false,
    limited = false;
  await page.route("**/api/v1/sales", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    if (!dropped) {
      dropped = true;
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
            message: "Verification retry throttled",
          },
        }),
      });
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "Confirm & post sale" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Response unconfirmed");
  await expect(
    page.getByText("A checkout is awaiting a confirmed response.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.context().setOffline(true);
  await dialog.getByRole("button", { name: "Save local capture" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "cannot become an offline capture",
  );
  await page.context().setOffline(false);
  await page.reload();
  await page.getByRole("button", { name: "Review & retry" }).click();
  const recovery = page.getByRole("dialog", { name: "Complete the sale" });
  await recovery.getByRole("button", { name: "Confirm & post sale" }).click();
  await expect(recovery.getByRole("alert")).toContainText(
    "Verification retry throttled",
  );
  await expect(
    page.getByRole("button", { name: "Review & retry" }),
  ).toBeVisible();
  await page.route(
    "**/api/v1/sales/*",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "RECEIPT_UNAVAILABLE",
            message: "Temporary receipt failure",
          },
        }),
      }),
    { times: 1 },
  );
  await recovery.getByRole("button", { name: "Confirm & post sale" }).click();
  await posted(page);
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  await expect(
    page.getByRole("button", { name: "Review & retry" }),
  ).not.toBeVisible();
  expect(command).toBeTruthy();
  await assertEffects(f, "60");
  const retry = await page.request.post("/api/v1/sales", {
    headers: {
      "X-CSRF-Token": command.headers["x-csrf-token"],
      "Idempotency-Key": command.headers["idempotency-key"],
      Origin: "http://127.0.0.1:3100",
    },
    data: command.body,
  });
  expect(retry.status()).toBe(200);
  await assertEffects(f, "60");
  expect(errors).toEqual([]);
  const original = (await retry.json()).data;
  const receipt = await page.request.get(
    "/api/v1/sales/" + original.id + "/receipt?thermal=true",
  );
  expect(receipt.status()).toBe(200);
  expect(receipt.headers()["content-type"]).toContain("application/pdf");
  expect((await receipt.body()).subarray(0, 5).toString()).toBe("%PDF-");
});
test("M-Pesa initiation is visibly pending and cannot post until independent test-provider confirmation", async ({
  page,
  workspace: f,
}) => {
  await login(page, f);
  await addCoffee(page);
  await page.getByRole("button", { name: "Continue to payment" }).click();
  const dialog = page.getByRole("dialog", { name: "Complete the sale" });
  await dialog.getByLabel("Payment method").selectOption(f.mpesa.id);
  await dialog.getByLabel("M-Pesa phone").fill("254712345678");
  await dialog.getByRole("button", { name: "Send prompt" }).click();
  await expect(
    dialog.getByRole("button", { name: "Confirm with test provider" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Confirm & post sale" }),
  ).toBeDisabled();
  await transaction(f.actor, async (ctx) =>
    assertEqual(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM sales WHERE company_id=$1",
          [f.companyId],
        )
      ).n,
      0,
    ),
  );
  await dialog
    .getByRole("button", { name: "Confirm with test provider" })
    .click();
  await expect(dialog).toContainText(
    "Confirmed by provider query and callback.",
  );
  await dialog.getByRole("button", { name: "Confirm & post sale" }).click();
  await posted(page);
  await assertEffects(f, "0");
  await transaction(f.actor, async (ctx) => {
    const i = await one(
      ctx,
      "SELECT status,consumed_by FROM payment_intents WHERE company_id=$1",
      [f.companyId],
    );
    expect(i.status).toBe("successful");
    expect(i.consumed_by).toBeTruthy();
  });
});
test("PO approval, partial accepted GRN and matched supplier invoice use the connected UI", async ({
  page,
  workspace: f,
}) => {
  await login(page, f);
  await page.goto("/purchasing");
  await page
    .getByRole("button", { name: "Purchase order", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "Create purchase order" });
  await pick(page, "Supplier", "Browser test supplier");
  await pick(page, "Add an item", "Browser test coffee");
  await dialog.getByLabel("Quantity for Browser test coffee").fill("5");
  await dialog.getByLabel("Unit cost").fill("40");
  await dialog.getByRole("button", { name: "Create draft PO" }).click();
  await expect(dialog).not.toBeVisible();
  await page.locator(".data-table tbody tr").first().click();
  await page.getByRole("button", { name: "Submit for approval" }).click();
  dialog = page.getByRole("dialog", {
    name: /Submitted purchase order|Approved purchase order/,
  });
  await dialog
    .getByLabel("Reason")
    .fill("E2E purchase submission for five units");
  await dialog.getByRole("button", { name: "Confirm transition" }).click();
  await page.getByRole("button", { name: "Approve order" }).click();
  dialog = page.getByRole("dialog", {
    name: /Submitted purchase order|Approved purchase order/,
  });
  await dialog
    .getByLabel("Reason")
    .fill("Explicit owner review in isolated E2E shop");
  await dialog.getByRole("button", { name: "Confirm transition" }).click();
  await page.getByRole("button", { name: "Receive goods" }).click();
  dialog = page.getByRole("dialog", { name: "Receive accepted goods" });
  await dialog.getByLabel("Accepted quantity").fill("3");
  await dialog.getByLabel("Rejected quantity").fill("1");
  await dialog
    .getByLabel("Delivery note / reason (required for over-delivery)")
    .fill("Three accepted, one rejected after inspection");
  await dialog.getByRole("button", { name: "Post goods receipt" }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog" })
    .click();
  await page
    .getByRole("button", { name: "Goods receipts", exact: true })
    .click();
  await page.locator(".data-table tbody tr").first().click();
  await page.getByRole("button", { name: "Match supplier invoice" }).click();
  dialog = page.getByRole("dialog", { name: "Match supplier invoice" });
  await dialog.getByLabel("Supplier invoice number").fill("E2E-SUP-0001");
  await dialog.getByLabel("Tax rule").selectOption(f.tax.id);
  await dialog.getByRole("button", { name: "Post supplier invoice" }).click();
  await expect(dialog).not.toBeVisible();
  await transaction(f.actor, async (ctx) => {
    expect(
      (
        await one(
          ctx,
          "SELECT quantity FROM stock_balances WHERE company_id=$1 AND product_id=$2",
          [f.companyId, f.product.id],
        )
      ).quantity,
    ).toBe("23.000000");
    expect(
      (
        await one(
          ctx,
          "SELECT total FROM supplier_invoices WHERE company_id=$1",
          [f.companyId],
        )
      ).total,
    ).toBe("139.20");
  });
});
test("two concurrent tabs retain both authorized local cash captures until explicit synchronization", async ({
  page,
  context,
  workspace: f,
}) => {
  test.setTimeout(150000);
  await login(page, f);
  await page.goto("/offline");
  await page.getByRole("button", { name: "Authorize this device" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Authorize a cash-capture device",
  });
  await dialog.getByLabel("Device label").fill("Isolated browser till");
  await dialog.getByRole("button", { name: "Authorize device" }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByLabel("Authorized device").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Cache authorized catalog" }).click();
  await expect(page).toHaveURL(/offline/);
  await expect(
    page.getByText("Authorized catalog cached on this device."),
  ).toBeVisible();
  await page.goto("/pos");
  await expect(
    page.getByText("Browser test coffee", { exact: true }),
  ).toBeVisible();
  const other = await context.newPage(),
    otherErrors: string[] = [];
  other.on("pageerror", (e) => otherErrors.push(e.message));
  await other.goto("/pos");
  await expect(other.getByText("Shift open", { exact: true })).toBeVisible();
  await expect(page.getByText("Shift open", { exact: true })).toBeVisible();
  await context.setOffline(true);
  for (const tab of [page, other]) {
    await tab
      .getByRole("button")
      .filter({ has: tab.getByText("Browser test coffee", { exact: true }) })
      .click();
    await tab.getByRole("button", { name: "Capture locally" }).click();
  }
  await Promise.all(
    [page, other].map((tab) =>
      tab
        .getByRole("dialog", { name: "Complete the sale" })
        .getByRole("button", { name: "Save local capture" })
        .click(),
    ),
  );
  for (const tab of [page, other])
    await expect(
      tab.getByRole("dialog", { name: "Complete the sale" }),
    ).not.toBeVisible();
  // Durable state, not a transient toast that can expire while the other tab
  // finishes under CI/resource pressure. This also detects lost RMW updates.
  const captured = await page.evaluate(
    (key) =>
      new Promise<any[]>((resolve, reject) => {
        const request = indexedDB.open("duka-private", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("data", "readonly"),
            get = tx.objectStore("data").get(key);
          get.onsuccess = () => resolve(get.result ?? []);
          get.onerror = () => reject(get.error);
          tx.oncomplete = () => db.close();
        };
      }),
    "queue:" + f.actor.id,
  );
  expect(captured).toHaveLength(2);
  expect(new Set(captured.map((q) => q.client_id)).size).toBe(2);
  expect(
    captured.every(
      (q) => q.status === "local" && q.captured_shift_id === f.shift.id,
    ),
  ).toBe(true);
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
  await context.setOffline(false);
  await page.goto("/shifts");
  await page.locator(".data-table tbody tr").first().click();
  await page.getByRole("button", { name: "Count & submit" }).click();
  const closing = page.getByRole("dialog", {
    name: "Count your closing balances",
  });
  await closing.getByRole("button", { name: "Submit counted shift" }).click();
  await expect(closing.getByRole("alert")).toContainText(
    "unconfirmed cash captures",
  );
  await transaction(f.actor, async (ctx) =>
    expect(
      (
        await one(
          ctx,
          "SELECT status FROM shifts WHERE company_id=$1 AND id=$2",
          [f.companyId, f.shift.id],
        )
      ).status,
    ).toBe("open"),
  );
  await page.goto("/offline");
  for (let i = 0; i < 2; i++) {
    await page
      .getByRole("button", { name: "Synchronize", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("link", { name: "View confirmed sale" }),
    ).toHaveCount(i + 1);
  }
  expect(otherErrors).toEqual([]);
  await other.close();
  await assertEffects(f, "232", 2);
});
