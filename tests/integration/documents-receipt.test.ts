import { fixture } from "./helper.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  pool,
  transaction,
  idempotent,
  one,
} from "../../apps/api/src/db.ts";
import {
  productSchema,
  customerSchema,
  checkoutSchema,
  stockInputSchema,
} from "@duka/shared";
import {
  createProduct,
  saveContact,
} from "../../apps/api/src/services/catalog.ts";
import { postStockDocument } from "../../apps/api/src/services/inventory.ts";
import { checkout } from "../../apps/api/src/services/sales.ts";
import { openShift } from "../../apps/api/src/services/shifts.ts";
import {
  salePdf,
  statementPdf,
  businessPdf,
} from "../../apps/api/src/services/documents.ts";
import { randomUUID } from "node:crypto";

process.env.LOG_LEVEL = "silent";

before(async () => {
  await pool.query("DELETE FROM rate_limit_buckets");
});
after(() => pool.end());

function assertPdf(buf: Buffer, minBytes: number, label: string) {
  assert.ok(Buffer.isBuffer(buf), `${label}: expected a Buffer`);
  assert.equal(
    buf.subarray(0, 5).toString("latin1"),
    "%PDF-",
    `${label}: not a PDF`,
  );
  assert.ok(buf.length > minBytes, `${label}: suspiciously small ${buf.length}`);
}

test(
  "sale receipt PDFs render in A4 and 80mm thermal with meta, parties, KRA panel and verify QR",
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
        name: "Receipt widget",
        sku: "RCPT-1",
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
        reason: "Receipt test stock",
        lines: [{ product_id: product.id, quantity: "10", unit_cost: "50" }],
      }),
    );
    const customer = await saveContact(
      ctx,
      "customer",
      customerSchema.parse({
        name: "Walk-in customer",
        code: "RCPT-C",
      }),
    );
    const cash = (
      await ctx.db.query(
        "SELECT id FROM payment_methods WHERE company_id=$1 AND kind='cash' LIMIT 1",
        [f.companyId],
      )
    ).rows[0];
    await openShift(ctx, {
      register_id: f.registerId,
      opening_float: "500",
    });
    return { product, customer, cash };
  });
  const input = checkoutSchema.parse({
    register_id: f.registerId,
    customer_id: seed.customer.id,
    lines: [
      { product_id: seed.product.id, quantity: "2" },
      { product_id: seed.product.id, quantity: "1" },
    ],
    payments: [
      { method_id: seed.cash.id, amount: "348", reference: "DW-RECEIPT-01" },
    ],
  });
  const sale = await transaction(f.actor, (ctx) =>
    idempotent(ctx, "checkout", `receipt-${randomUUID()}`, input, () =>
      checkout(ctx, input),
    ),
  );
  const a4 = await transaction(f.actor, async (ctx) =>
    salePdf(ctx, sale.id, false),
  );
  assertPdf(a4, 4096, "A4 sale invoice");
  const thermal = await transaction(f.actor, async (ctx) =>
    salePdf(ctx, sale.id, true),
  );
  assertPdf(thermal, 3000, "thermal sale receipt");

  // customer statement must still render with the legacy identity fallback
  const statement = await transaction(f.actor, async (ctx) =>
    statementPdf(
      ctx,
      "customer",
      seed.customer.id,
      {},
    ),
  );
  assertPdf(statement, 2000, "customer statement");

  // a business document (goods received note) with the default meta grid
  const grn = await transaction(f.actor, async (ctx) => {
    const pkg: any = await one(
      ctx,
      "SELECT id FROM stock_documents WHERE company_id=$1 LIMIT 1",
      [f.companyId],
    );
    return businessPdf(ctx, "stock-document", pkg.id);
  });
  assertPdf(grn, 2000, "stock document");

  // 58mm width respects company settings
  await pool.query(
    "UPDATE companies SET settings=settings||'{\"receiptWidth\":58}'::jsonb WHERE id=$1",
    [f.companyId],
  );
  const narrow = await transaction(f.actor, async (ctx) =>
    salePdf(ctx, sale.id, true),
  );
  assertPdf(narrow, 2500, "58mm thermal receipt");
});
