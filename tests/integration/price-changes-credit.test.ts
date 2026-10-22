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
