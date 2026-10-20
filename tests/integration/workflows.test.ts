import { fixture } from "./helper.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction, one, type Actor } from "../../apps/api/src/db.ts";
import {
  productSchema,
  checkoutSchema,
  stockInputSchema,
  documentSchema,
  saleReturnSchema,
  expenseSchema,
} from "@duka/shared";
import { createProduct } from "../../apps/api/src/services/catalog.ts";
import {
  postStockDocument,
  reconcileInventory,
} from "../../apps/api/src/services/inventory.ts";
import { openShift } from "../../apps/api/src/services/shifts.ts";
import {
  checkout,
  getSale,
  returnSale,
} from "../../apps/api/src/services/sales.ts";
import {
  createDocument,
  transitionDocument,
  createExpense,
  reviewExpense,
  payExpense,
  acquireAsset,
  depreciateAsset,
} from "../../apps/api/src/services/business.ts";
import {
  createIntent,
  dispatchIntent,
  mockComplete,
  callbackToken,
  receiveCallback,
  processMpesaEvent,
} from "../../apps/api/src/integrations/mpesa.ts";
import {
  catalogVersion,
  syncSale,
} from "../../apps/api/src/services/offline.ts";
import { trialBalance } from "../../apps/api/src/services/reports.ts";
import {
  configureUser,
  configureRole,
} from "../../apps/api/src/services/admin.ts";
after(() => pool.end());
async function business(tracked = false) {
  const f = await fixture();
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
    const p = await createProduct(
      ctx,
      productSchema.parse({
        name: "Workflow item",
        sku: "WORKFLOW",
        price: "116",
        purchase_cost: "50",
        unit_id: unit.id,
        tax_rule_id: tax.id,
        batch_tracked: tracked,
        serial_tracked: tracked,
      }),
    );
    await postStockDocument(
      ctx,
      stockInputSchema.parse({
        type: "opening",
        warehouse_id: f.warehouseId,
        reason: "Verified physical opening inventory",
        lines: [
          {
            product_id: p.id,
            quantity: "10",
            unit_cost: "50",
            ...(tracked
              ? {
                  batch_number: "BATCH-A",
                  serials: Array.from({ length: 10 }, (_, i) => "SERIAL-" + i),
                }
              : {}),
          },
        ],
      }),
    );
    const shift = await openShift(ctx, {
      register_id: f.registerId,
      opening_float: "1000",
    });
    const methods = (
      await ctx.db.query("SELECT * FROM payment_methods WHERE company_id=$1", [
        f.companyId,
      ])
    ).rows;
    return {
      ...f,
      p,
      unit,
      tax,
      shift,
      cash: methods.find((m) => m.kind === "cash"),
      bank: methods.find((m) => m.kind === "bank"),
      mpesa: methods.find((m) => m.kind === "mpesa"),
    };
  });
}
test("batch/serial transfers preserve location and value; a serial cannot be taken from a different batch", async () => {
  const f = await business(true);
  let destination = "";
  await transaction(f.actor, async (ctx) => {
    destination = (
      await ctx.db.query(
        "INSERT INTO warehouses(company_id,branch_id,name,code) VALUES($1,$2,'Secondary warehouse','SECOND') RETURNING id",
        [f.companyId, f.branchId],
      )
    ).rows[0].id;
  });
  const actor = {
    ...f.actor,
    warehouse_ids: [...f.actor.warehouse_ids, destination],
  };
  const batch = await transaction(actor, (ctx) =>
    one(
      ctx,
      "SELECT * FROM stock_batches WHERE company_id=$1 AND product_id=$2",
      [f.companyId, f.p.id],
    ),
  );
  await transaction(actor, (ctx) =>
    postStockDocument(
      ctx,
      stockInputSchema.parse({
        type: "transfer",
        warehouse_id: f.warehouseId,
        destination_id: destination,
        reason: "Physical two-item warehouse transfer",
        lines: [
          {
            product_id: f.p.id,
            quantity: "2",
            batch_id: batch.id,
            serials: ["SERIAL-0", "SERIAL-1"],
          },
        ],
      }),
    ),
  );
  await transaction(actor, async (ctx) => {
    const s = await one(
      ctx,
      "SELECT * FROM serial_numbers WHERE company_id=$1 AND serial='SERIAL-0'",
      [f.companyId],
    );
    assert.equal(s.warehouse_id, destination);
    assert.equal(s.status, "available");
    assert.notEqual(s.batch_id, batch.id);
    assert.equal((await reconcileInventory(ctx)).matches, true);
  });
  await transaction(actor, (ctx) =>
    postStockDocument(
      ctx,
      stockInputSchema.parse({
        type: "adjustment",
        warehouse_id: f.warehouseId,
        reason: "Receive alternate batch for batch ownership test",
        lines: [
          {
            product_id: f.p.id,
            quantity: "1",
            unit_cost: "50",
            batch_number: "BATCH-B",
            serials: ["OTHER-SERIAL"],
          },
        ],
      }),
    ),
  );
  const sale = checkoutSchema.parse({
    register_id: f.registerId,
    lines: [
      {
        product_id: f.p.id,
        quantity: "1",
        batch_id: batch.id,
        serials: ["OTHER-SERIAL"],
      },
    ],
    payments: [{ method_id: f.cash.id, amount: "116" }],
  });
  await assert.rejects(
    () => transaction(actor, (ctx) => checkout(ctx, sale)),
    /unavailable/,
  );
});
test("selling-unit conversion returns the correct base serials and exact COGS", async () => {
  const f = await business(true);
  const batch = await transaction(f.actor, (ctx) =>
    one(
      ctx,
      "SELECT id FROM stock_batches WHERE company_id=$1 AND product_id=$2",
      [f.companyId, f.p.id],
    ),
  );
  const box = await transaction(f.actor, async (ctx) => {
    const u = (
      await ctx.db.query(
        "INSERT INTO units(company_id,name,symbol,fractional) VALUES($1,'Pair','pair',false) RETURNING id",
        [f.companyId],
      )
    ).rows[0];
    await ctx.db.query(
      "INSERT INTO product_units(company_id,product_id,unit_id,factor) VALUES($1,$2,$3,2)",
      [f.companyId, f.p.id, u.id],
    );
    return u;
  });
  const sale = await transaction(f.actor, (ctx) =>
    checkout(
      ctx,
      checkoutSchema.parse({
        register_id: f.registerId,
        lines: [
          {
            product_id: f.p.id,
            unit_id: box.id,
            quantity: "2",
            batch_id: batch.id,
            serials: ["SERIAL-0", "SERIAL-1", "SERIAL-2", "SERIAL-3"],
          },
        ],
        payments: [{ method_id: f.cash.id, amount: "464" }],
      }),
    ),
  );
  const invoice = await transaction(f.actor, (ctx) => getSale(ctx, sale.id));
  for (let i = 0; i < 2; i++)
    await transaction(f.actor, (ctx) =>
      returnSale(
        ctx,
        saleReturnSchema.parse({
          sale_id: sale.id,
          shift_id: f.shift.id,
          reason: "Return one unopened pair",
          lines: [
            { sale_line_id: invoice.lines[0].id, quantity: "1", restock: true },
          ],
          payments: [{ method_id: f.cash.id, amount: "232" }],
        }),
      ),
    );
  await transaction(f.actor, async (ctx) => {
    assert.equal(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM serial_numbers WHERE company_id=$1 AND status='available'",
          [f.companyId],
        )
      ).n,
      10,
    );
    assert.equal((await reconcileInventory(ctx)).matches, true);
    assert.equal((await trialBalance(ctx, {})).balanced, true);
  });
});
test("approved orders reserve stock and match base quantities, not a spoofed selling-unit quantity", async () => {
  const f = await business();
  const pair = await transaction(f.actor, async (ctx) => {
    const u = (
      await ctx.db.query(
        "INSERT INTO units(company_id,name,symbol) VALUES($1,'Pair','pair') RETURNING id",
        [f.companyId],
      )
    ).rows[0];
    await ctx.db.query(
      "INSERT INTO product_units(company_id,product_id,unit_id,factor) VALUES($1,$2,$3,2)",
      [f.companyId, f.p.id, u.id],
    );
    return u;
  });
  const order = await transaction(f.actor, (ctx) =>
    createDocument(
      ctx,
      documentSchema.parse({
        kind: "sales_order",
        branch_id: f.branchId,
        warehouse_id: f.warehouseId,
        lines: [{ product_id: f.p.id, unit_id: pair.id, quantity: "1" }],
      }),
    ),
  );
  await transaction(f.actor, (ctx) =>
    transitionDocument(
      ctx,
      order.id,
      "submitted",
      "Submit approved-order test",
    ),
  );
  await transaction(f.actor, (ctx) =>
    transitionDocument(
      ctx,
      order.id,
      "approved",
      "Explicit self approval for isolated test",
    ),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        checkout(
          ctx,
          checkoutSchema.parse({
            order_id: order.id,
            register_id: f.registerId,
            lines: [{ product_id: f.p.id, quantity: "1" }],
            payments: [{ method_id: f.cash.id, amount: "116" }],
          }),
        ),
      ),
    /approved quantities/,
  );
  await transaction(f.actor, (ctx) =>
    checkout(
      ctx,
      checkoutSchema.parse({
        order_id: order.id,
        register_id: f.registerId,
        lines: [{ product_id: f.p.id, unit_id: pair.id, quantity: "1" }],
        payments: [{ method_id: f.cash.id, amount: "232" }],
      }),
    ),
  );
  await transaction(f.actor, async (ctx) => {
    const b = await one(
      ctx,
      "SELECT * FROM stock_balances WHERE company_id=$1 AND product_id=$2",
      [f.companyId, f.p.id],
    );
    assert.equal(b.quantity, "8.000000");
    assert.equal(b.reserved, "0.000000");
    assert.equal(
      (
        await one(
          ctx,
          "SELECT status FROM business_documents WHERE company_id=$1 AND id=$2",
          [f.companyId, order.id],
        )
      ).status,
      "converted",
    );
    assert.equal((await reconcileInventory(ctx)).matches, true);
  });
});
test("count versions reject stale counts without changing inventory, and old stock dates fail closed", async () => {
  const f = await business();
  const count = stockInputSchema.parse({
    type: "count",
    warehouse_id: f.warehouseId,
    reason: "Physical count snapshot test",
    lines: [{ product_id: f.p.id, quantity: "9", expected_version: 1 }],
  });
  await transaction(f.actor, (ctx) =>
    checkout(
      ctx,
      checkoutSchema.parse({
        register_id: f.registerId,
        lines: [{ product_id: f.p.id, quantity: "1" }],
        payments: [{ method_id: f.cash.id, amount: "116" }],
      }),
    ),
  );
  await assert.rejects(
    () => transaction(f.actor, (ctx) => postStockDocument(ctx, count)),
    /changed since this count/,
  );
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        postStockDocument(
          ctx,
          stockInputSchema.parse({
            type: "adjustment",
            warehouse_id: f.warehouseId,
            reason: "Attempt backdated inventory movement",
            accounting_date: yesterday,
            lines: [{ product_id: f.p.id, quantity: "1", unit_cost: "50" }],
          }),
        ),
      ),
    /cannot be backdated/,
  );
  await transaction(f.actor, async (ctx) => {
    assert.equal((await reconcileInventory(ctx)).matches, true);
  });
});
test("M-Pesa callbacks alone cannot confirm or fund a sale; query binding, deduplication and consumption are enforced", async () => {
  process.env.DEMO_MODE = "true";
  const f = await business();
  const intent = await transaction(f.actor, (ctx) =>
    createIntent(ctx, {
      branch_id: f.branchId,
      amount: "116",
      phone: "254712345678",
    }),
  );
  await dispatchIntent(f.actor, intent.id);
  const state = await transaction(f.actor, (ctx) =>
    one(ctx, "SELECT * FROM payment_intents WHERE company_id=$1 AND id=$2", [
      f.companyId,
      intent.id,
    ]),
  );
  const callback = {
    Body: {
      stkCallback: {
        CheckoutRequestID: state.checkout_id,
        ResultCode: 0,
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: 116 },
            { Name: "PhoneNumber", Value: "254712345678" },
            { Name: "MpesaReceiptNumber", Value: "TESTRECEIPT-001" },
          ],
        },
      },
    },
  };
  await assert.rejects(
    () => receiveCallback("attacker-token", callback),
    /Callback rejected/,
  );
  await receiveCallback(callbackToken(intent.id), callback);
  const event = (
    await pool.query("SELECT id FROM provider_events WHERE checkout_id=$1", [
      state.checkout_id,
    ])
  ).rows[0];
  await assert.rejects(
    () => processMpesaEvent(event.id),
    /still reports pending/,
  );
  const sale = checkoutSchema.parse({
    register_id: f.registerId,
    lines: [{ product_id: f.p.id, quantity: "1" }],
    payments: [{ method_id: f.mpesa.id, amount: "116", intent_id: intent.id }],
  });
  await assert.rejects(
    () => transaction(f.actor, (ctx) => checkout(ctx, sale)),
    /unconfirmed|successful/,
  );
  const completed = await transaction(f.actor, (ctx) =>
    mockComplete(ctx, intent.id, "successful"),
  );
  await assert.rejects(() => processMpesaEvent(event.id), /receipt metadata/);
  callback.Body.stkCallback.CallbackMetadata.Item[2].Value = completed.receipt;
  await receiveCallback(callbackToken(intent.id), callback);
  const verified = (
    await pool.query(
      "SELECT id FROM provider_events WHERE checkout_id=$1 AND id<>$2",
      [state.checkout_id, event.id],
    )
  ).rows[0];
  await processMpesaEvent(verified.id);
  await receiveCallback(callbackToken(intent.id), callback);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM provider_events WHERE checkout_id=$1",
        [state.checkout_id],
      )
    ).rows[0].n,
    2,
  );
  await transaction(f.actor, (ctx) => checkout(ctx, sale));
  await assert.rejects(
    () => transaction(f.actor, (ctx) => checkout(ctx, sale)),
    /consumed|already/,
  );
  await assert.rejects(
    () => transaction(f.actor, (ctx) => mockComplete(ctx, intent.id, "failed")),
    /final provider outcome/,
  );
});
test("offline sync persists conflicts, posts once, rejects ID reuse and never treats mobile money as paid", async () => {
  const f = await business();
  const device = await transaction(f.actor, (ctx) =>
    ctx.db
      .query(
        "INSERT INTO offline_devices(company_id,user_id,register_id,label,max_sale_amount) VALUES($1,$2,$3,'Isolated test device',500) RETURNING id",
        [f.companyId, f.userId, f.registerId],
      )
      .then((r) => r.rows[0]),
  );
  const version = await transaction(f.actor, catalogVersion);
  const input = {
    client_id: randomUUID(),
    device_id: device.id,
    catalog_version: "old-catalog-version",
    captured_at: new Date().toISOString(),
    captured_shift_id: f.shift.id,
    accept_changes: false,
    sale: checkoutSchema.parse({
      register_id: f.registerId,
      lines: [{ product_id: f.p.id, quantity: "1" }],
      payments: [{ method_id: f.cash.id, amount: "116" }],
    }),
  };
  const conflict = await transaction(f.actor, (ctx) => syncSale(ctx, input));
  assert.equal(conflict.status, "conflict");
  assert.equal((conflict as any).error.code, "OFFLINE_CATALOG_CHANGED");
  await transaction(f.actor, async (ctx) =>
    assert.equal(
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
  const accepted = await transaction(f.actor, (ctx) =>
    syncSale(ctx, { ...input, accept_changes: true }),
  );
  assert.equal(accepted.status, "posted");
  const duplicate = await transaction(f.actor, (ctx) =>
    syncSale(ctx, { ...input, catalog_version: version, accept_changes: true }),
  );
  assert.equal(duplicate.status, "posted");
  assert.equal((duplicate as any).duplicate, true);
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        syncSale(ctx, {
          ...input,
          sale: { ...input.sale, notes: "Changed original cash transaction" },
        }),
      ),
    /different data/,
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        syncSale(ctx, {
          ...input,
          client_id: randomUUID(),
          sale: {
            ...input.sale,
            payments: [{ method_id: f.mpesa.id, amount: "116" }],
          },
        }),
      ),
    /cannot be confirmed/,
  );
  await transaction(f.actor, async (ctx) => {
    assert.equal(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM sales WHERE company_id=$1",
          [f.companyId],
        )
      ).n,
      1,
    );
    assert.equal((await reconcileInventory(ctx)).matches, true);
  });
});
test("expense approval separates request from posting; fixed-asset monthly depreciation is capped and unique", async () => {
  const f = await business();
  const category = await transaction(f.actor, (ctx) =>
    one(ctx, "SELECT id FROM expense_categories WHERE company_id=$1 LIMIT 1", [
      f.companyId,
    ]),
  );
  const expense = await transaction(f.actor, (ctx) =>
    createExpense(
      ctx,
      expenseSchema.parse({
        branch_id: f.branchId,
        category_id: category.id,
        description: "Isolated transport voucher",
        net: "100",
        tax_rule_id: f.tax.id,
      }),
    ),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        payExpense(ctx, expense.id, {
          payment: {
            method_id: f.bank.id,
            amount: "116",
            reference: "EXP-TEST",
          },
        }),
      ),
    /must be approved/,
  );
  await transaction(f.actor, (ctx) =>
    reviewExpense(
      ctx,
      expense.id,
      "approved",
      "Explicit self approval in isolated test",
    ),
  );
  await transaction(f.actor, (ctx) =>
    payExpense(ctx, expense.id, {
      payment: { method_id: f.bank.id, amount: "116", reference: "EXP-TEST" },
    }),
  );
  const today = new Date().toISOString().slice(0, 10);
  const asset = await transaction(f.actor, (ctx) =>
    acquireAsset(ctx, {
      branch_id: f.branchId,
      name: "Opening test desk",
      cost: "1200",
      residual: "0",
      useful_months: 12,
      acquired_date: today,
    }),
  );
  const run = await transaction(f.actor, (ctx) =>
    depreciateAsset(ctx, asset.id, today),
  );
  assert.equal(run.amount, "100.00");
  await assert.rejects(
    () => transaction(f.actor, (ctx) => depreciateAsset(ctx, asset.id, today)),
    /duplicate key/,
  );
  await transaction(f.actor, async (ctx) =>
    assert.equal((await trialBalance(ctx, {})).balanced, true),
  );
});
test("delivery notes retain the posted invoice snapshot after catalog price changes and issue no extra stock", async () => {
  const f = await business();
  const sale = await transaction(f.actor, (ctx) =>
    checkout(
      ctx,
      checkoutSchema.parse({
        register_id: f.registerId,
        lines: [{ product_id: f.p.id, quantity: "1" }],
        payments: [{ method_id: f.cash.id, amount: "116" }],
      }),
    ),
  );
  await transaction(f.actor, (ctx) =>
    ctx.db.query(
      "UPDATE products SET price=232 WHERE company_id=$1 AND id=$2",
      [f.companyId, f.p.id],
    ),
  );
  const note = await transaction(f.actor, (ctx) =>
    createDocument(
      ctx,
      documentSchema.parse({
        kind: "delivery_note",
        branch_id: f.branchId,
        sale_id: sale.id,
        lines: [{ product_id: f.p.id, quantity: "999" }],
      }),
    ),
  );
  assert.equal(note.total, "116.00");
  await transaction(f.actor, async (ctx) => {
    assert.equal(
      (
        await one(
          ctx,
          "SELECT quantity FROM stock_balances WHERE company_id=$1 AND product_id=$2",
          [f.companyId, f.p.id],
        )
      ).quantity,
      "9.000000",
    );
  });
});

test("offline captures bind to their original shift and never post into a replacement drawer or an unassigned warehouse", async () => {
  const { closeShift } = await import("../../apps/api/src/services/shifts.ts");
  const f = await business();
  const device = await transaction(f.actor, (ctx) =>
    one(
      ctx,
      "INSERT INTO offline_devices(company_id,user_id,register_id,label,max_sale_amount) VALUES($1,$2,$3,'Shift binding probe',500) RETURNING id",
      [f.companyId, f.userId, f.registerId],
    ),
  );
  const captured = {
    client_id: randomUUID(),
    device_id: device.id,
    catalog_version: await transaction(f.actor, catalogVersion),
    captured_at: new Date().toISOString(),
    captured_shift_id: f.shift.id,
    accept_changes: false,
    sale: checkoutSchema.parse({
      register_id: f.registerId,
      lines: [{ product_id: f.p.id, quantity: "1" }],
      payments: [{ method_id: f.cash.id, amount: "116" }],
    }),
  };
  const replacement = await transaction(f.actor, async (ctx) => {
    await closeShift(ctx, f.shift.id, { counts: { [f.cash.id]: "500" } });
    return openShift(ctx, { register_id: f.registerId, opening_float: "500" });
  });
  const stale = await transaction(f.actor, (ctx) => syncSale(ctx, captured));
  assert.equal(stale.status, "conflict");
  assert.equal((stale as any).error.code, "OFFLINE_SHIFT_CHANGED");
  const { captured_shift_id, ...legacy } = captured;
  const missing = await transaction(f.actor, (ctx) =>
    syncSale(ctx, { ...legacy, client_id: randomUUID() }),
  );
  assert.equal((missing as any).error.code, "OFFLINE_SHIFT_REQUIRED");
  const denied = await transaction({ ...f.actor, warehouse_ids: [] }, (ctx) =>
    syncSale(ctx, {
      ...captured,
      client_id: randomUUID(),
      captured_at: new Date().toISOString(),
      captured_shift_id: replacement.id,
    }),
  );
  assert.equal((denied as any).error.code, "WAREHOUSE_FORBIDDEN");
  await transaction(f.actor, async (ctx) =>
    assert.equal(
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
});
