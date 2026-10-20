import { fixture } from "./helper.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction, one, type Actor } from "../../apps/api/src/db.ts";
import {
  productSchema,
  supplierSchema,
  customerSchema,
  checkoutSchema,
} from "@duka/shared";
import {
  createProduct,
  saveContact,
} from "../../apps/api/src/services/catalog.ts";
import {
  createPurchaseOrder,
  transitionPurchaseOrder,
  receiveGoods,
  recognizeSupplierInvoice,
  returnSupplierGoods,
} from "../../apps/api/src/services/procurement.ts";
import {
  settleContact,
  invoiceOutstanding,
  saleOutstanding,
} from "../../apps/api/src/services/payments.ts";
import {
  settleSupplierCredit,
  reverseSupplierCredit,
} from "../../apps/api/src/services/supplier-credits.ts";
import { postJournal } from "@duka/accounting";
import {
  openShift,
  expectedShift,
} from "../../apps/api/src/services/shifts.ts";
import { checkout } from "../../apps/api/src/services/sales.ts";
import { verifyIntegrity } from "../../apps/api/src/services/integrity.ts";
import { aging, balanceSheet } from "../../apps/api/src/services/reports.ts";
after(() => pool.end());
async function setup() {
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
      ),
      tax = await one(
        ctx,
        "SELECT id FROM tax_rules WHERE company_id=$1 AND code='VAT16'",
        [f.companyId],
      );
    const product = await createProduct(
      ctx,
      productSchema.parse({
        name: "Supplier credit item",
        sku: "CREDIT",
        unit_id: unit.id,
        tax_rule_id: tax.id,
        price: "116",
        purchase_cost: "50",
      }),
    );
    const supplier = await saveContact(
        ctx,
        "supplier",
        supplierSchema.parse({ name: "Credit supplier", code: "CREDIT" }),
      ),
      otherSupplier = await saveContact(
        ctx,
        "supplier",
        supplierSchema.parse({ name: "Other supplier", code: "OTHER" }),
      );
    const methods = (
        await ctx.db.query(
          "SELECT * FROM payment_methods WHERE company_id=$1",
          [f.companyId],
        )
      ).rows,
      bank = methods.find((m) => m.kind === "bank"),
      cash = methods.find((m) => m.kind === "cash");
    const shift = await openShift(ctx, {
      register_id: f.registerId,
      opening_float: "500",
    });
    await postJournal(ctx, {
      branchId: f.branchId,
      date: new Date().toISOString().slice(0, 10),
      sourceType: "opening",
      sourceId: randomUUID(),
      description: "Explicit bank capital and existing physical drawer float",
      lines: [
        { account: "bank", debit: "1000" },
        { account: "cash", debit: "500" },
        { account: "equity", credit: "1500" },
      ],
    });
    return { ...f, product, tax, supplier, otherSupplier, bank, cash, shift };
  });
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function invoice(f: Fixture, supplierId = f.supplier.id) {
  return transaction(f.actor, async (ctx) => {
    const po = await createPurchaseOrder(ctx, {
      supplier_id: supplierId,
      warehouse_id: f.warehouseId,
      lines: [{ product_id: f.product.id, quantity: "2", unit_cost: "50" }],
    });
    await transitionPurchaseOrder(
      ctx,
      po.id,
      "submitted",
      "Credit integration submission",
    );
    await transitionPurchaseOrder(
      ctx,
      po.id,
      "approved",
      "Explicit owner approval of credit fixture",
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
    const i = await recognizeSupplierInvoice(ctx, {
      receipt_id: grn.id,
      supplier_reference: randomUUID(),
      due_date: new Date().toISOString().slice(0, 10),
      lines: [{ receipt_line_id: line.id, net: "100", tax_rule_id: f.tax.id }],
    });
    return { ...i, receipt_line_id: line.id };
  });
}
async function paidReturn(
  f: Fixture,
  source: Awaited<ReturnType<typeof invoice>>,
) {
  await transaction(f.actor, (ctx) =>
    settleContact(ctx, "supplier", {
      branch_id: f.branchId,
      contact_id: f.supplier.id,
      payment: { method_id: f.bank.id, amount: "116", reference: randomUUID() },
      allocations: [{ document_id: source.id, amount: "116" }],
    }),
  );
  await transaction(f.actor, (ctx) =>
    returnSupplierGoods(ctx, {
      invoice_id: source.id,
      reason: "Return all of the paid goods",
      lines: [{ receipt_line_id: source.receipt_line_id, quantity: "2" }],
    }),
  );
}
test("paid supplier credit offsets, refunds and append-only reversals reconcile invoices, aging, cash and GL without rewriting source history", async () => {
  const f = await setup(),
    source = await invoice(f),
    target = await invoice(f);
  await paidReturn(f, source);
  const snapshot = await transaction(f.actor, (ctx) =>
    one(
      ctx,
      "SELECT md5(to_jsonb(s)::text) AS hash FROM supplier_invoices s WHERE company_id=$1 AND id=$2",
      [f.companyId, source.id],
    ),
  );
  const first = await transaction(f.actor, (ctx) =>
    settleSupplierCredit(ctx, {
      kind: "offset",
      invoice_id: source.id,
      target_invoice_id: target.id,
      amount: "40.01",
      reason: "Use paid-return credit against the next supplier invoice",
    }),
  );
  assert.equal(first.source_outstanding, "-75.99");
  assert.equal(first.target_outstanding, "75.99");
  await transaction(f.actor, (ctx) =>
    reverseSupplierCredit(ctx, first.id, {
      reason: "Correct the credit allocation through an append-only reversal",
    }),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        reverseSupplierCredit(ctx, first.id, {
          reason: "A duplicate reversal must not post",
        }),
      ),
    /already reversed/,
  );
  await transaction(f.actor, (ctx) =>
    settleSupplierCredit(ctx, {
      kind: "offset",
      invoice_id: source.id,
      target_invoice_id: target.id,
      amount: "50.25",
      reason: "Approved corrected invoice credit allocation",
    }),
  );
  const refund = await transaction(f.actor, (ctx) =>
    settleSupplierCredit(ctx, {
      kind: "refund",
      invoice_id: source.id,
      amount: "30.10",
      shift_id: f.shift.id,
      payment: { method_id: f.cash.id },
      reason: "Supplier actually refunded this amount into the cash drawer",
    }),
  );
  await transaction(f.actor, (ctx) =>
    reverseSupplierCredit(ctx, refund.id, {
      payment: { method_id: f.bank.id, reference: randomUUID() },
      reason: "Actual bank repayment to reinstate the supplier credit",
    }),
  );
  await transaction(f.actor, (ctx) =>
    settleSupplierCredit(ctx, {
      kind: "refund",
      invoice_id: source.id,
      amount: "65.75",
      payment: { method_id: f.bank.id, reference: randomUUID() },
      reason: "Remaining credit received and matched to the bank statement",
    }),
  );
  await transaction(f.actor, async (ctx) => {
    assert.equal(
      (await invoiceOutstanding(ctx, source.id)).outstanding,
      "0.00",
    );
    assert.equal(
      (await invoiceOutstanding(ctx, target.id)).outstanding,
      "65.75",
    );
    assert.equal(
      (
        await one(
          ctx,
          "SELECT md5(to_jsonb(s)::text) AS hash FROM supplier_invoices s WHERE company_id=$1 AND id=$2",
          [f.companyId, source.id],
        )
      ).hash,
      snapshot.hash,
    );
    assert.equal(
      (await expectedShift(ctx, f.shift.id)).expected_cash,
      "530.10",
    );
    const ap = await aging(ctx, "supplier", { contact_id: f.supplier.id });
    assert.equal(ap.items.length, 1);
    assert.equal(ap.items[0].outstanding, "65.75");
    assert.equal((await verifyIntegrity(ctx)).matches, true);
    assert.equal((await balanceSheet(ctx, {})).difference, "0.00");
    const count = await one(
      ctx,
      "SELECT count(*)::int AS n FROM supplier_credit_settlements WHERE company_id=$1",
      [f.companyId],
    );
    assert.equal(count.n, 6);
  });
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        ctx.db.query(
          "UPDATE supplier_credit_settlements SET reason='overwrite' WHERE company_id=$1 AND id=$2",
          [f.companyId, first.id],
        ),
      ),
    /immutable|cannot|posted/i,
  );
});
test("supplier credit concurrency, raw multi-row overdraw guard, cross-contact/scope/date checks and cash-payout limits fail closed", async () => {
  const f = await setup(),
    source = await invoice(f),
    target = await invoice(f),
    other = await invoice(f, f.otherSupplier.id);
  await paidReturn(f, source);
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        settleSupplierCredit(ctx, {
          kind: "offset",
          invoice_id: source.id,
          target_invoice_id: other.id,
          amount: "1",
          reason: "Cross-contact allocation must fail",
        }),
      ),
    /same supplier/,
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        settleSupplierCredit(ctx, {
          kind: "offset",
          invoice_id: source.id,
          target_invoice_id: target.id,
          amount: "1",
          accounting_date: new Date(Date.now() - 86400000)
            .toISOString()
            .slice(0, 10),
          reason: "Do not use credit before it exists",
        }),
      ),
    /cannot precede/,
  );
  const attempt = () =>
    transaction(f.actor, (ctx) =>
      settleSupplierCredit(ctx, {
        kind: "offset",
        invoice_id: source.id,
        target_invoice_id: target.id,
        amount: "80",
        reason: "Concurrent credit allocation regression",
      }),
    );
  const raced = await Promise.allSettled([attempt(), attempt()]);
  assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(raced.filter((r) => r.status === "rejected").length, 1);
  const successful = (
    raced.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>
  ).value;
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        await ctx.db.query(
          `INSERT INTO supplier_credit_settlements(id,company_id,branch_id,supplier_id,from_invoice_id,to_invoice_id,kind,number,amount,accounting_date,reason,created_by) VALUES($1,$3,$4,$5,$6,$7,'offset',$8,20,CURRENT_DATE,'Raw multirow overdraw probe',$10),($2,$3,$4,$5,$6,$7,'offset',$9,20,CURRENT_DATE,'Raw multirow overdraw probe',$10)`,
          [
            randomUUID(),
            randomUUID(),
            f.companyId,
            f.branchId,
            f.supplier.id,
            source.id,
            target.id,
            randomUUID(),
            randomUUID(),
            f.actor.id,
          ],
        );
        throw Object.assign(new Error("Missing multirow guard"), {
          code: "PROBE_GUARD_MISSING",
        });
      }),
    (e: any) => e.code === "23514",
  );
  await transaction(f.actor, (ctx) =>
    settleSupplierCredit(ctx, {
      kind: "refund",
      invoice_id: source.id,
      amount: "36",
      payment: { method_id: f.bank.id, reference: randomUUID() },
      reason: "Receive the unallocated supplier credit",
    }),
  );
  const reversed = await Promise.allSettled([
    transaction(f.actor, (ctx) =>
      reverseSupplierCredit(ctx, successful.id, {
        reason: "Concurrent controlled credit reversal",
      }),
    ),
    transaction(f.actor, (ctx) =>
      reverseSupplierCredit(ctx, successful.id, {
        reason: "Concurrent controlled credit reversal",
      }),
    ),
  ]);
  assert.equal(reversed.filter((r) => r.status === "fulfilled").length, 1);
  await transaction(f.actor, (ctx) =>
    settleSupplierCredit(ctx, {
      kind: "refund",
      invoice_id: source.id,
      amount: "80",
      payment: { method_id: f.bank.id, reference: randomUUID() },
      reason: "Receive the credit restored by the reversal",
    }),
  );
  await assert.rejects(
    () =>
      transaction({ ...f.actor, branch_ids: [] } as Actor, (ctx) =>
        settleSupplierCredit(ctx, {
          kind: "offset",
          invoice_id: source.id,
          target_invoice_id: target.id,
          amount: "1",
          reason: "Unassigned branch must not be accessed",
        }),
      ),
    /branch/i,
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        settleContact(ctx, "supplier", {
          branch_id: f.branchId,
          contact_id: f.supplier.id,
          shift_id: f.shift.id,
          payment: { method_id: f.cash.id, amount: "600" },
          allocations: [{ document_id: target.id, amount: "116" }],
        }),
      ),
    /physical cash/,
  );
  await transaction(f.actor, async (ctx) => {
    assert.equal((await verifyIntegrity(ctx)).matches, true);
    assert.equal(
      (await expectedShift(ctx, f.shift.id)).expected_cash,
      "500.00",
    );
    assert.equal(
      (
        await one(
          ctx,
          "SELECT count(*)::int AS n FROM supplier_payments WHERE company_id=$1",
          [f.companyId],
        )
      ).n,
      1,
    );
  });
});
test("outstanding helpers re-read child allocations after a parent lock wait instead of returning the pre-wait snapshot", async () => {
  const f = await setup(),
    purchase = await invoice(f);
  const customer = await transaction(f.actor, (ctx) =>
    saveContact(
      ctx,
      "customer",
      customerSchema.parse({
        name: "Snapshot customer",
        code: "SNAP",
        credit_limit: "500",
      }),
    ),
  );
  const sale = await transaction(f.actor, (ctx) =>
    checkout(
      ctx,
      checkoutSchema.parse({
        register_id: f.registerId,
        customer_id: customer.id,
        lines: [{ product_id: f.product.id, quantity: "1" }],
        payments: [],
      }),
    ),
  );
  for (const [kind, id, contactId] of [
    ["customer", sale.id, customer.id],
    ["supplier", purchase.id, f.supplier.id],
  ] as const) {
    let release!: () => void, locked!: () => void;
    const wait = new Promise<void>((r) => (release = r)),
      held = new Promise<void>((r) => (locked = r));
    let waiterPid = 0;
    const payer = transaction(f.actor, async (ctx) => {
      await ctx.db.query(
        `SELECT id FROM ${kind === "customer" ? "sales" : "supplier_invoices"} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
        [f.companyId, id],
      );
      locked();
      await wait;
      await settleContact(ctx, kind, {
        branch_id: f.branchId,
        contact_id: contactId,
        payment: {
          method_id: f.bank.id,
          amount: "116",
          reference: randomUUID(),
        },
        allocations: [{ document_id: id, amount: "116" }],
      });
    });
    await held;
    const waiting = transaction(f.actor, async (ctx) => {
      waiterPid = (await ctx.db.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      return kind === "customer"
        ? saleOutstanding(ctx, id)
        : invoiceOutstanding(ctx, id);
    });
    try {
      let blocked = false;
      for (let i = 0; i < 200; i++) {
        if (
          waiterPid &&
          (
            await pool.query(
              "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
              [waiterPid],
            )
          ).rows[0]?.wait_event_type === "Lock"
        ) {
          blocked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(
        blocked,
        true,
        "Prove an actual PostgreSQL parent-row lock wait",
      );
    } finally {
      release();
    }
    await payer;
    assert.equal((await waiting).outstanding, "0.00");
  }
  await transaction(f.actor, async (ctx) =>
    assert.equal((await verifyIntegrity(ctx)).matches, true),
  );
});
