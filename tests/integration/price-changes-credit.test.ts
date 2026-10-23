import { fixture } from "./helper.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { pool, transaction, idempotent, one } from "../../apps/api/src/db.ts";
import {
  productSchema,
  customerSchema,
  checkoutSchema,
  stockInputSchema,
  saleReturnSchema,
} from "@duka/shared";
import {
  createProduct,
  saveContact,
  changePrices,
  priceChanges,
} from "../../apps/api/src/services/catalog.ts";
import { postStockDocument } from "../../apps/api/src/services/inventory.ts";
import {
  checkout,
  returnSale,
  getSale,
} from "../../apps/api/src/services/sales.ts";
import { openShift } from "../../apps/api/src/services/shifts.ts";
import { randomUUID } from "node:crypto";

process.env.LOG_LEVEL = "silent";
after(() => pool.end());

test(
  "credit sales post outstanding balances; returns always value at the original sale price even after a price change; price changes are tracked",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    const seed = await transaction(f.actor, async (ctx) => {
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
          name: "Repriced widget",
          sku: "RPC-1",
          price: "116",
          purchase_cost: "50",
          unit_id: unit.id,
          tax_rule_id: tax.id,
        }),
      );
      await postStockDocument(
        ctx,
        stockInputSchema.parse({
          type: "opening",
          warehouse_id: f.warehouseId,
          reason: "Price change test stock",
          lines: [{ product_id: product.id, quantity: "20", unit_cost: "50" }],
        }),
      );
      const customer = await saveContact(
        ctx,
        "customer",
        customerSchema.parse({
          name: "Credit buyer",
          code: "CR-1",
          credit_limit: "100000",
        }),
      );
      await openShift(ctx, { register_id: f.registerId, opening_float: "0" });
      return { product, customer };
    });

    // 1) a credit sale with zero tenders leaves the full balance outstanding
    const creditSale = await transaction(f.actor, (ctx) =>
      idempotent(
        ctx,
        "checkout",
        `credit-${randomUUID()}`,
        { sale: true },
        () =>
          checkout(
            ctx,
            checkoutSchema.parse({
              register_id: f.registerId,
              customer_id: seed.customer.id,
              lines: [{ product_id: seed.product.id, quantity: "2" }],
              payments: [],
            }),
          ),
      ),
    );
    assert.equal(creditSale.total, "232.00");
    assert.equal(creditSale.outstanding, "232.00");
    const arCheck = await transaction(f.actor, async (ctx) =>
      (
        await ctx.db.query(
          "SELECT coalesce(sum(l.debit-l.credit),0)::text AS n FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND l.customer_id=$2 AND a.system_key='ar'",
          [ctx.companyId, seed.customer.id],
        )
      ).rows[0].n,
    );
    assert.equal(arCheck, "232.00");

    // 2) change the price; the change is recorded and visible
    const change = await transaction(f.actor, (ctx) =>
      changePrices(ctx, {
        reason: "Supplier increased wholesale costs",
        prices: [{ product_id: seed.product.id, price: "200" }],
      }),
    );
    assert.equal(change.changed, 1);
    assert.equal(change.items[0].old_price, "116.00");
    assert.equal(change.items[0].new_price, "200.00");
    const listOne = await transaction(f.actor, (ctx) =>
      priceChanges(ctx, { product_id: seed.product.id, limit: 10 }),
    );
    assert.equal(listOne.total, 1);
    assert.equal(listOne.items[0].actor, "Business Owner");
    assert.match(listOne.items[0].reason, /wholesale/);
    const sold = await transaction(f.actor, (ctx) =>
      getSale(ctx, creditSale.id),
    );
    assert.equal(sold.lines[0].total, "232.00", "posted sale is untouched");

    // 3) the return prices from the original sale line, not the new price
    const cr = await transaction(f.actor, async (ctx) => {
      const sale = await getSale(ctx, creditSale.id);
      return returnSale(
        ctx,
        saleReturnSchema.parse({
          sale_id: creditSale.id,
          reason: "Damaged on delivery",
          credit_to_account: true,
          lines: [
            { sale_line_id: sale.lines[0].id, quantity: "1", restock: true },
          ],
          payments: [],
        }),
      );
    });
    assert.equal(
      cr.total,
      "116.00",
      "return values the original selling price, not the new catalog price",
    );
    const crRow = await transaction(f.actor, async (ctx) =>
      one(
        ctx,
        "SELECT total,tax,credit_applied FROM sale_returns WHERE company_id=$1 AND id=$2",
        [ctx.companyId, cr.id],
      ),
    );
    assert.equal(crRow.total, "116.00");
    assert.equal(crRow.tax, "16.00");
    assert.equal(
      crRow.credit_applied,
      "116.00",
      "credit offsets the outstanding invoice balance first",
    );

    // 4) outstanding drops by the credited amount
    const outstanding = await transaction(f.actor, async (ctx) => {
      const s = await getSale(ctx, creditSale.id, true);
      return s.outstanding;
    });
    assert.equal(outstanding, "116.00");

    // 5) a follow-up sale uses the new price, proving the change landed
    const newSale = await transaction(f.actor, (ctx) =>
      idempotent(ctx, "checkout", `new-${randomUUID()}`, { sale: true }, () =>
        checkout(
          ctx,
          checkoutSchema.parse({
            register_id: f.registerId,
            customer_id: seed.customer.id,
            lines: [{ product_id: seed.product.id, quantity: "1" }],
            payments: [],
          }),
        ),
      ),
    );
    assert.equal(newSale.total, "200.00");
  },
);

/** HTTP-surface guard for the price-change endpoints (route registrations can
 * be lost without service-level tests noticing, as the UI depends on them). */
test("price change HTTP endpoints exist, track changes and stay tenant-safe", { timeout: 30000 }, async () => {
  const { createApp } = await import("../../apps/api/src/app.ts");
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  try {
    const f = await fixture();
    const login = await fetch(base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email: f.actor.email, password: "TestSecurePass-2026" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const csrf = (await login.json()).data.csrf_token;
    const heads = { cookie, "X-CSRF-Token": csrf, "content-type": "application/json", origin: "http://localhost:3000" };
    async function call(path: string, options: any = {}) {
      const r = await fetch(base + path, {
        method: options.method ?? "GET",
        headers: { ...heads, ...(options.method ? { "Idempotency-Key": randomUUID() } : {}) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    }
    // seed a product directly through the service
    const product = await transaction(f.actor, async (ctx) => {
      const unit = await one(ctx, "SELECT id FROM units WHERE company_id=$1 AND symbol='pc'", [f.companyId]);
      const tax = await one(ctx, "SELECT id FROM tax_rules WHERE company_id=$1 AND code='VAT16'", [f.companyId]);
      return createProduct(
        ctx,
        productSchema.parse({
          name: "HTTP price widget",
          sku: "HPW-1",
          price: "50",
          purchase_cost: "20",
          unit_id: unit.id,
          tax_rule_id: tax.id,
        }),
      );
    });
    // unauthenticated -> 401
    assert.equal((await fetch(base + "/api/v1/price-changes")).status, 401);
    // apply a change through the HTTP endpoint
    const post = await call("/api/v1/products/bulk-prices", {
      method: "POST",
      body: {
        reason: "Quarterly markup review",
        prices: [{ product_id: product.id, price: "65" }],
      },
    });
    assert.equal(post.status, 200, JSON.stringify(post.json));
    assert.equal(post.json.data.changed, 1);
    assert.equal(post.json.data.items[0].old_price, "50.00");
    // ledger surfaced over HTTP
    const ledger = await call("/api/v1/price-changes?product_id=" + product.id);
    assert.equal(ledger.status, 200);
    assert.equal(ledger.json.data.total, 1);
    assert.equal(ledger.json.data.items[0].new_price, "65.00");
    // catalog list reflects the new price
    const cat = await call("/api/v1/products?q=HPW-1");
    assert.equal(cat.json.data.items[0].price, "65.00");
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});
