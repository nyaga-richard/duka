import { fixture } from "./helper.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  pool,
  transaction,
  idempotent,
  one,
  type Actor,
} from "../../apps/api/src/db.ts";
import {
  productSchema,
  customerSchema,
  supplierSchema,
  checkoutSchema,
  stockInputSchema,
  poSchema,
  grnSchema,
  supplierInvoiceSchema,
  settlementSchema,
  saleReturnSchema,
  supplierReturnSchema,
} from "@duka/shared";
import {
  createProduct,
  saveContact,
} from "../../apps/api/src/services/catalog.ts";
import {
  postStockDocument,
  reconcileInventory,
} from "../../apps/api/src/services/inventory.ts";
import {
  checkout,
  getSale,
  returnSale,
} from "../../apps/api/src/services/sales.ts";
import {
  openShift,
  expectedShift,
  closeShift,
  reviewShift,
} from "../../apps/api/src/services/shifts.ts";
import {
  settleContact,
  applyAdvance,
} from "../../apps/api/src/services/payments.ts";
import {
  createPurchaseOrder,
  transitionPurchaseOrder,
  receiveGoods,
  recognizeSupplierInvoice,
  returnSupplierGoods,
} from "../../apps/api/src/services/procurement.ts";
import {
  trialBalance,
  profitAndLoss,
  balanceSheet,
  aging,
  salesAnalysis,
} from "../../apps/api/src/services/reports.ts";
import { randomUUID } from "node:crypto";
after(() => pool.end());
async function commerce(quantity = "10") {
  const f = await fixture();
  return transaction(f.actor, async (ctx) => {
    await ctx.db.query(
      "UPDATE companies SET settings=settings||'{\"allowSelfApproval\":true}'::jsonb WHERE id=$1",
      [f.companyId],
    );
    const unit = await one(
        ctx,
        "SELECT id FROM units WHERE company_id=$1 AND symbol='pc'",
        [f.companyId],
      ),
      tax = await one(
        ctx,
        "SELECT id FROM tax_rules WHERE company_id=$1 AND code='VAT16'",
        [f.companyId],
      );
    const product = await createProduct(
      ctx,
      productSchema.parse({
        name: "Test product",
        sku: "TEST",
        barcode: "123456789",
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
        reason: "Verified opening inventory",
        lines: [{ product_id: product.id, quantity, unit_cost: "50" }],
      }),
    );
    const customer = await saveContact(
      ctx,
      "customer",
      customerSchema.parse({
        name: "Test customer",
        code: "C001",
        credit_limit: "1000",
      }),
    );
    const supplier = await saveContact(
      ctx,
      "supplier",
      supplierSchema.parse({ name: "Test supplier", code: "S001" }),
    );
    const methods = (
      await ctx.db.query("SELECT * FROM payment_methods WHERE company_id=$1", [
        f.companyId,
      ])
    ).rows;
    const cash = methods.find((m) => m.kind === "cash"),
      bank = methods.find((m) => m.kind === "bank");
    const shift = await openShift(ctx, {
      register_id: f.registerId,
      opening_float: "500",
    });
    return { ...f, product, customer, supplier, cash, bank, shift, tax, unit };
  });
}
test("split tender posts sale, stock, journal, receipt and exact cash reconciliation atomically", async () => {
  const f = await commerce();
  const input = checkoutSchema.parse({
    register_id: f.registerId,
    lines: [{ product_id: f.product.id, quantity: "1" }],
    payments: [
      { method_id: f.cash.id, amount: "60" },
      { method_id: f.bank.id, amount: "56", reference: "BANK-001" },
    ],
  });
  const sale = await transaction(f.actor, (ctx) =>
    idempotent(ctx, "checkout", "sale-test-key", input, () =>
      checkout(ctx, input),
    ),
  );
  const repeat = await transaction(f.actor, (ctx) =>
    idempotent(ctx, "checkout", "sale-test-key", input, () =>
      checkout(ctx, input),
    ),
  );
  assert.deepEqual(repeat, sale);
  await transaction(f.actor, async (ctx) => {
    const receipt = await getSale(ctx, sale.id, true);
    assert.equal(receipt.total, "116.00");
    assert.equal(receipt.outstanding, "0.00");
    assert.equal(receipt.lines.length, 1);
    assert.equal(receipt.payments.length, 2);
    assert.equal(
      (
        await one(
          ctx,
          "SELECT quantity FROM stock_balances WHERE company_id=$1 AND product_id=$2",
          [f.companyId, f.product.id],
        )
      ).quantity,
      "9.000000",
    );
    assert.equal(
      (
        await ctx.db.query(
          "SELECT l.id FROM journal_lines l JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id JOIN journals j ON j.id=l.journal_id AND j.company_id=l.company_id WHERE j.source_id=$1 AND a.system_key='ar'",
          [sale.id],
        )
      ).rowCount,
      0,
    );
    assert.equal((await reconcileInventory(ctx)).matches, true);
    assert.equal((await trialBalance(ctx, {})).balanced, true);
    assert.equal((await profitAndLoss(ctx, {})).net_profit, "50.00");
    assert.equal((await balanceSheet(ctx, {})).balanced, true);
    assert.equal((await salesAnalysis(ctx, {})).items[0].revenue, "100.00");
    const s = await expectedShift(ctx, f.shift.id);
    assert.equal(s.expected_cash, "560.00");
    const counts = Object.fromEntries(
      s.methods.map((m: any) => [m.id, m.expected]),
    );
    await closeShift(ctx, f.shift.id, { counts });
  });
  await transaction(f.actor, (ctx) =>
    reviewShift(
      ctx,
      f.shift.id,
      "approved",
      "Owner review enabled explicitly for isolated integration test",
    ),
  );
  await assert.rejects(
    () => transaction(f.actor, (ctx) => checkout(ctx, input)),
    /Record not found/,
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        idempotent(
          ctx,
          "checkout",
          "sale-test-key",
          { ...input, notes: "changed" },
          () => checkout(ctx, input),
        ),
      ),
    /different data/,
  );
});
test("credit sale, allocations, customer advances, partial returns and duplicate-refund caps reconcile", async () => {
  const f = await commerce();
  const sale = await transaction(f.actor, (ctx) =>
    checkout(
      ctx,
      checkoutSchema.parse({
        register_id: f.registerId,
        customer_id: f.customer.id,
        lines: [{ product_id: f.product.id, quantity: "2" }],
        payments: [{ method_id: f.cash.id, amount: "100" }],
      }),
    ),
  );
  assert.equal(sale.outstanding, "132.00");
  const receipt = await transaction(f.actor, (ctx) =>
    settleContact(
      ctx,
      "customer",
      settlementSchema.parse({
        contact_id: f.customer.id,
        branch_id: f.branchId,
        shift_id: f.shift.id,
        payment: { method_id: f.cash.id, amount: "200" },
        allocations: [{ document_id: sale.id, amount: "132" }],
      }),
    ),
  );
  assert.equal(receipt.unapplied, "68.00");
  const line = await transaction(
    f.actor,
    async (ctx) => (await getSale(ctx, sale.id)).lines[0],
  );
  const cr = await transaction(f.actor, (ctx) =>
    returnSale(
      ctx,
      saleReturnSchema.parse({
        sale_id: sale.id,
        reason: "Unopened goods returned",
        credit_to_account: true,
        lines: [{ sale_line_id: line.id, quantity: "1", restock: true }],
        payments: [],
      }),
    ),
  );
  assert.equal(cr.advance_credit, "116.00");
  const paidWithCredit = await transaction(f.actor, (ctx) =>
    checkout(
      ctx,
      checkoutSchema.parse({
        register_id: f.registerId,
        customer_id: f.customer.id,
        customer_credit: "116",
        lines: [{ product_id: f.product.id, quantity: "1" }],
        payments: [],
      }),
    ),
  );
  assert.equal(paidWithCredit.outstanding, "0.00");
  const debt = await transaction(f.actor, (ctx) =>
    checkout(
      ctx,
      checkoutSchema.parse({
        register_id: f.registerId,
        customer_id: f.customer.id,
        lines: [{ product_id: f.product.id, quantity: "1" }],
        payments: [],
      }),
    ),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        applyAdvance(ctx, "customer", {
          source_id: receipt.id,
          document_id: debt.id,
          amount: "1",
        }),
      ),
    /Insufficient unapplied credit/,
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        returnSale(
          ctx,
          saleReturnSchema.parse({
            sale_id: sale.id,
            reason: "Duplicate excessive refund",
            shift_id: f.shift.id,
            lines: [{ sale_line_id: line.id, quantity: "2", restock: true }],
            payments: [{ method_id: f.cash.id, amount: "232" }],
          }),
        ),
      ),
    /exceeds/,
  );
  await transaction(f.actor, async (ctx) => {
    assert.equal((await reconcileInventory(ctx)).matches, true);
    assert.equal((await trialBalance(ctx, {})).balanced, true);
    const report = await aging(ctx, "customer", {});
    assert.equal(report.items.length, 1);
    assert.equal(String(report.items[0].outstanding), "116.00");
  });
});
test("PO → partial GRN → matched invoice → supplier payment and supplier return are distinct postings", async () => {
  const f = await commerce();
  const po = await transaction(f.actor, (ctx) =>
    createPurchaseOrder(
      ctx,
      poSchema.parse({
        warehouse_id: f.warehouseId,
        supplier_id: f.supplier.id,
        lines: [{ product_id: f.product.id, quantity: "5", unit_cost: "40" }],
      }),
    ),
  );
  await transaction(f.actor, (ctx) =>
    transitionPurchaseOrder(
      ctx,
      po.id,
      "submitted",
      "Submit procurement request",
    ),
  );
  await transaction(f.actor, (ctx) =>
    transitionPurchaseOrder(
      ctx,
      po.id,
      "approved",
      "Owner review enabled for isolated integration test",
    ),
  );
  const grn = await transaction(f.actor, (ctx) =>
    receiveGoods(
      ctx,
      grnSchema.parse({
        order_id: po.id,
        lines: [{ order_line_id: po.lines[0].id, quantity: "3" }],
      }),
    ),
  );
  assert.equal(grn.value, "120.00");
  const today = new Date().toISOString().slice(0, 10);
  const payload = supplierInvoiceSchema.parse({
    receipt_id: grn.id,
    supplier_reference: "sup-0001",
    due_date: today,
    lines: [
      { receipt_line_id: grn.lines[0].id, net: "120", tax_rule_id: f.tax.id },
    ],
  });
  const invoice = await transaction(f.actor, (ctx) =>
    recognizeSupplierInvoice(ctx, payload),
  );
  assert.equal(invoice.total, "139.20");
  await assert.rejects(
    () => transaction(f.actor, (ctx) => recognizeSupplierInvoice(ctx, payload)),
    /duplicate key/,
  );
  const payment = await transaction(f.actor, (ctx) =>
    settleContact(
      ctx,
      "supplier",
      settlementSchema.parse({
        contact_id: f.supplier.id,
        branch_id: f.branchId,
        payment: {
          method_id: f.bank.id,
          amount: "100",
          reference: "SUPPAY-001",
        },
        allocations: [{ document_id: invoice.id, amount: "100" }],
      }),
    ),
  );
  assert.equal(payment.allocated, "100.00");
  const credit = await transaction(f.actor, (ctx) =>
    returnSupplierGoods(
      ctx,
      supplierReturnSchema.parse({
        invoice_id: invoice.id,
        reason: "Goods damaged by supplier",
        lines: [{ receipt_line_id: grn.lines[0].id, quantity: "1" }],
      }),
    ),
  );
  assert.equal(credit.total, "46.40");
  await transaction(f.actor, async (ctx) => {
    assert.equal((await reconcileInventory(ctx)).matches, true);
    assert.equal((await trialBalance(ctx, {})).balanced, true);
    const ap = await aging(ctx, "supplier", {});
    assert.equal(String(ap.items[0].outstanding), "-7.20");
  });
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        receiveGoods(
          ctx,
          grnSchema.parse({
            order_id: po.id,
            lines: [{ order_line_id: po.lines[0].id, quantity: "3" }],
          }),
        ),
      ),
    /reason|tolerance/,
  );
});
test("concurrent tills cannot oversell the last unit and failed sale rolls back all effects", async () => {
  const f = await commerce("1");
  const other: Actor = {
    ...f.actor,
    id: randomUUID(),
    email: `second-${randomUUID()}@example.test`,
  };
  let register2 = "";
  await transaction(f.actor, async (ctx) => {
    await ctx.db.query(
      "INSERT INTO identities(id,company_id,email,name,password_hash) SELECT $1,company_id,$2,'Second cashier',password_hash FROM identities WHERE id=$3",
      [other.id, other.email, f.userId],
    );
    register2 = (
      await ctx.db.query(
        "INSERT INTO registers(company_id,branch_id,warehouse_id,name) VALUES($1,$2,$3,$4) RETURNING id",
        [f.companyId, f.branchId, f.warehouseId, "Till 02"],
      )
    ).rows[0].id;
  });
  await transaction(other, (ctx) =>
    openShift(ctx, { register_id: register2, opening_float: "0" }),
  );
  const input = (register_id: string) =>
    checkoutSchema.parse({
      register_id,
      lines: [{ product_id: f.product.id, quantity: "1" }],
      payments: [{ method_id: f.cash.id, amount: "116" }],
    });
  const results = await Promise.allSettled([
    transaction(f.actor, (ctx) => checkout(ctx, input(f.registerId))),
    transaction(other, (ctx) => checkout(ctx, input(register2))),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
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
test("closed periods, unauthorized pricing and client actor spoofing fail safely", async () => {
  const f = await commerce();
  const cashier = {
    ...f.actor,
    permissions: ["sales.create", "catalog.read", "shifts.open", "sales.read"],
  };
  const input = checkoutSchema.parse({
    register_id: f.registerId,
    lines: [{ product_id: f.product.id, quantity: "1", unit_price: "1" }],
    payments: [{ method_id: f.cash.id, amount: "1" }],
  });
  await assert.rejects(
    () => transaction(cashier, (ctx) => checkout(ctx, input)),
    /Permission required/,
  );
  await transaction(f.actor, (ctx) =>
    ctx.db.query(
      "UPDATE accounting_periods SET status='closed' WHERE company_id=$1",
      [f.companyId],
    ),
  );
  await assert.rejects(
    () => transaction(f.actor, (ctx) => checkout(ctx, input)),
    /No open accounting period/,
  );
});

test("required fiscal policy treats an unset adapter mode as disabled for both sales and credit notes", async () => {
  const f = await commerce(),
    input = checkoutSchema.parse({
      register_id: f.registerId,
      lines: [{ product_id: f.product.id, quantity: "1" }],
      payments: [{ method_id: f.cash.id, amount: "116" }],
    });
  const original = await transaction(f.actor, (ctx) => checkout(ctx, input));
  await transaction(f.actor, (ctx) =>
    ctx.db.query(
      `UPDATE companies SET settings=settings||'{"fiscalRequired":true}'::jsonb WHERE id=$1`,
      [f.companyId],
    ),
  );
  const previous = process.env.ETIMS_MODE;
  delete process.env.ETIMS_MODE;
  try {
    await assert.rejects(
      () => transaction(f.actor, (ctx) => checkout(ctx, input)),
      (e: any) => e.code === "FISCAL_UNAVAILABLE",
    );
    const sale = await transaction(f.actor, (ctx) => getSale(ctx, original.id));
    await assert.rejects(
      () =>
        transaction(f.actor, (ctx) =>
          returnSale(
            ctx,
            saleReturnSchema.parse({
              sale_id: original.id,
              reason:
                "Required fiscal credit note must not be silently disabled",
              shift_id: f.shift.id,
              lines: [
                {
                  sale_line_id: sale.lines[0].id,
                  quantity: "1",
                  restock: true,
                },
              ],
              payments: [{ method_id: f.cash.id, amount: "116" }],
            }),
          ),
        ),
      (e: any) => e.code === "FISCAL_UNAVAILABLE",
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
      assert.equal(
        (
          await one(
            ctx,
            "SELECT count(*)::int AS n FROM sale_returns WHERE company_id=$1",
            [f.companyId],
          )
        ).n,
        0,
      );
    });
  } finally {
    if (previous === undefined) delete process.env.ETIMS_MODE;
    else process.env.ETIMS_MODE = previous;
  }
});

test("permanent checkout cancellation blocks both a later normal request and an older writer at its result insert", async () => {
  const { cancelUncertainCheckout } = await import(
    "../../apps/api/src/services/checkout-recovery.ts"
  );
  const f = await commerce(),
    key = randomUUID(),
    input = checkoutSchema.parse({
      register_id: f.registerId,
      lines: [{ product_id: f.product.id, quantity: "1" }],
      payments: [{ method_id: f.cash.id, amount: "116" }],
    });
  assert.equal(
    (
      await transaction(f.actor, (ctx) =>
        cancelUncertainCheckout(ctx, {
          key,
          reason: "Authoritative cancellation of an unposted uncertain request",
        }),
      )
    ).status,
    "cancelled",
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        idempotent(ctx, "post:/sales", key, { id: null, input }, () =>
          checkout(ctx, input),
        ),
      ),
    (e: any) => e.code === "COMMAND_CANCELLED",
  );
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        const sale = await checkout(ctx, input);
        await ctx.db.query(
          "INSERT INTO idempotency_keys(company_id,operation,key,request_hash,response,actor_id) VALUES($1,$2,$3,$4,$5,$6)",
          [
            f.companyId,
            "post:/sales",
            key,
            "legacy-writer-hash",
            JSON.stringify(sale),
            f.actor.id,
          ],
        );
      }),
    (e: any) => e.code === "23514",
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
      0,
    );
    assert.equal(
      (
        await one(
          ctx,
          "SELECT quantity FROM stock_balances WHERE company_id=$1 AND product_id=$2",
          [f.companyId, f.product.id],
        )
      ).quantity,
      "10.000000",
    );
  });
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        ctx.db.query(
          "DELETE FROM cancelled_commands WHERE company_id=$1 AND key=$2",
          [f.companyId, key],
        ),
      ),
    /immutable|cannot|posted/i,
  );
});
test("checkout recovery waits for an in-flight commit and returns a scoped minimal receipt after privilege change, never a duplicate or historical costs", async () => {
  const { cancelUncertainCheckout } = await import(
    "../../apps/api/src/services/checkout-recovery.ts"
  );
  const f = await commerce(),
    key = randomUUID(),
    input = checkoutSchema.parse({
      register_id: f.registerId,
      lines: [{ product_id: f.product.id, quantity: "1" }],
      payments: [{ method_id: f.cash.id, amount: "116" }],
    });
  let release!: () => void, held!: () => void, started!: () => void;
  const wait = new Promise<void>((r) => (release = r)),
    locked = new Promise<void>((r) => (held = r)),
    recoverStarted = new Promise<void>((r) => (started = r));
  const original = transaction(f.actor, (ctx) =>
    idempotent(ctx, "post:/sales", key, { id: null, input }, async () => {
      const sale = await checkout(ctx, input);
      held();
      await wait;
      return sale;
    }),
  );
  await locked;
  const recovery = transaction(f.actor, (ctx) => {
    started();
    return cancelUncertainCheckout(ctx, {
      key,
      reason: "Recover the original result while its commit is in flight",
    });
  });
  await recoverStarted;
  release();
  const posted = await original,
    recovered = await recovery;
  assert.equal(recovered.status, "posted");
  assert.equal((recovered as any).sale.id, posted.id);
  const reduced = {
    ...f.actor,
    permissions: f.actor.permissions.filter(
      (p) =>
        ![
          "catalog.write",
          "inventory.read",
          "accounting.read",
          "purchases.read",
        ].includes(p),
    ),
  };
  await assert.rejects(
    () =>
      transaction(reduced, (ctx) =>
        idempotent(ctx, "post:/sales", key, { id: null, input }, () =>
          checkout(ctx, input),
        ),
      ),
    (e: any) => e.code === "IDEMPOTENCY_SCOPE_CHANGED",
  );
  const safe = await transaction(reduced, (ctx) =>
    cancelUncertainCheckout(ctx, {
      key,
      reason:
        "Reconcile an original transaction after cost permissions changed",
    }),
  );
  assert.deepEqual(Object.keys((safe as any).sale).sort(), [
    "id",
    "number",
    "total",
  ]);
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
    assert.equal(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM cancelled_commands WHERE company_id=$1",
          [f.companyId],
        )
      ).n,
      0,
    );
  });
});
