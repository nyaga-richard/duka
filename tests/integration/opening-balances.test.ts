import { fixture } from "./helper.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction, one, idempotent } from "../../apps/api/src/db.ts";
import {
  saveContact,
  createProduct,
} from "../../apps/api/src/services/catalog.ts";
import {
  customerSchema,
  supplierSchema,
  productSchema,
  checkoutSchema,
} from "@duka/shared";
import {
  saveOpeningBatch,
  transitionOpeningBatch,
  postOpeningBatch,
  getOpeningBatch,
  reverseOpeningBatch,
  openingMetadata,
  applyCreditToOpening,
} from "../../apps/api/src/services/opening-balances.ts";
import {
  settleContact,
  applyAdvance,
} from "../../apps/api/src/services/payments.ts";
import { postJournal } from "@duka/accounting";
import { openShift } from "../../apps/api/src/services/shifts.ts";
import { postStockDocument } from "../../apps/api/src/services/inventory.ts";
import { checkout } from "../../apps/api/src/services/sales.ts";
import {
  aging,
  profitAndLoss,
  balanceSheet,
  taxSummary,
  contactStatement,
} from "../../apps/api/src/services/reports.ts";
import { verifyIntegrity } from "../../apps/api/src/services/integrity.ts";
after(() => pool.end());
async function setup() {
  const f = await fixture();
  return transaction(f.actor, async (ctx) => {
    await ctx.db.query(
      `UPDATE companies SET settings=settings||'{"allowSelfApproval":true}'::jsonb WHERE id=$1`,
      [f.companyId],
    );
    const dates = await one(
      ctx,
      "SELECT to_char(now() AT TIME ZONE timezone,'YYYY-MM-DD') AS today,(now() AT TIME ZONE timezone)::date-1 AS cutover FROM companies WHERE id=$1",
      [f.companyId],
    );
    const cutover = (
      await one(ctx, "SELECT $1::date::text AS date", [dates.cutover])
    ).date;
    const customer = await saveContact(
        ctx,
        "customer",
        customerSchema.parse({
          name: "Legacy customer",
          code: "LEG-C",
          credit_limit: "650",
        }),
      ),
      supplier = await saveContact(
        ctx,
        "supplier",
        supplierSchema.parse({ name: "Legacy supplier", code: "LEG-S" }),
      );
    const bank = await one(
      ctx,
      "SELECT * FROM payment_methods WHERE company_id=$1 AND kind='bank'",
      [f.companyId],
    );
    return { ...f, customer, supplier, bank, today: dates.today, cutover };
  });
}
type F = Awaited<ReturnType<typeof setup>>;
function input(
  f: F,
  reference = "Reviewed legacy ledger cutover",
  ar = "600",
  ap = "400",
) {
  return {
    branch_id: f.branchId,
    accounting_date: f.cutover,
    reference,
    items: [
      {
        kind: "customer" as const,
        contact_code: "LEG-C",
        reference: "OLD-AR-001",
        original_date: "2025-01-01",
        due_date: "2025-01-31",
        amount: ar,
        description:
          "Outstanding only; prior revenue/tax already belongs to legacy books",
      },
      {
        kind: "supplier" as const,
        contact_id: f.supplier.id,
        reference: "OLD-AP-001",
        original_date: "2025-01-01",
        due_date: "2025-02-01",
        amount: ap,
      },
    ],
  };
}
async function posted(f: F) {
  const b = await transaction(f.actor, (ctx) =>
    saveOpeningBatch(ctx, input(f)),
  );
  await transaction(f.actor, (ctx) =>
    transitionOpeningBatch(
      ctx,
      b.id,
      "submitted",
      "Reviewed source references and old-ledger reconciliation",
    ),
  );
  return transaction(f.actor, (ctx) =>
    postOpeningBatch(
      ctx,
      b.id,
      "Explicit owner approval of opening AR/AP under the test self-approval policy",
    ),
  );
}
test("opening AR/AP posts no fake turnover/tax/stock/cash and participates in aging, credit limits, receipts, payments and booked advances", async () => {
  const f = await setup(),
    batch = await posted(f),
    ar = batch.items.find((i: any) => i.kind === "customer"),
    ap = batch.items.find((i: any) => i.kind === "supplier");
  await transaction(f.actor, async (ctx) => {
    assert.equal(batch.receivables, "600.00");
    assert.equal(batch.payables, "400.00");
    assert.equal(ar.outstanding, "600.00");
    assert.equal(ap.outstanding, "400.00");
    for (const table of [
      "sales",
      "supplier_invoices",
      "goods_receipts",
      "payments",
      "stock_movements",
    ])
      assert.equal(
        (
          await one(
            ctx,
            `SELECT count(*)::int AS n FROM ${table} WHERE company_id=$1`,
            [f.companyId],
          )
        ).n,
        0,
      );
    assert.equal(
      (await profitAndLoss(ctx, { from: f.cutover, to: f.cutover })).net_profit,
      "0.00",
    );
    const tax = await taxSummary(ctx, { from: f.cutover, to: f.cutover });
    assert.equal(tax.output_tax, "0.00");
    assert.equal(tax.input_tax, "0.00");
    assert.equal(
      (await balanceSheet(ctx, { to: f.cutover })).difference,
      "0.00",
    );
    assert.equal((await verifyIntegrity(ctx)).matches, true);
    const debt = await aging(ctx, "customer", { to: f.cutover });
    assert.equal(debt.items[0].document_type, "opening");
    assert.equal(debt.items[0].outstanding, "600.00");
    assert.equal(debt.items[0].bucket, "90+");
    assert.equal(
      (await aging(ctx, "supplier", { to: f.cutover })).items[0].outstanding,
      "400.00",
    );
  });
  const snapshot = await transaction(f.actor, (ctx) =>
    one(
      ctx,
      "SELECT md5(to_jsonb(b)::text) AS hash FROM opening_batches b WHERE company_id=$1 AND id=$2",
      [f.companyId, batch.id],
    ),
  );
  const product = await transaction(f.actor, async (ctx) => {
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
    const p = await createProduct(
      ctx,
      productSchema.parse({
        name: "After cutover item",
        sku: "AFTER",
        unit_id: unit.id,
        tax_rule_id: tax.id,
        price: "116",
      }),
    );
    await postStockDocument(ctx, {
      type: "opening",
      warehouse_id: f.warehouseId,
      reason: "Separately verified stock, not generated by debtor import",
      lines: [{ product_id: p.id, quantity: "10", unit_cost: "10" }],
    });
    await openShift(ctx, { register_id: f.registerId, opening_float: "0" });
    return p;
  });
  const saleInput = checkoutSchema.parse({
    register_id: f.registerId,
    customer_id: f.customer.id,
    lines: [{ product_id: product.id, quantity: "1" }],
    payments: [],
  });
  await assert.rejects(
    () =>
      transaction(
        {
          ...f.actor,
          permissions: f.actor.permissions.filter(
            (p) => p !== "sales.credit_override",
          ),
        },
        (ctx) => checkout(ctx, saleInput),
      ),
    (e: any) => e.status === 403,
  );
  const receipt = await transaction(f.actor, (ctx) =>
    settleContact(ctx, "customer", {
      branch_id: f.branchId,
      contact_id: f.customer.id,
      payment: { method_id: f.bank.id, amount: "200", reference: randomUUID() },
      allocations: [
        { document_id: ar.id, document_type: "opening", amount: "200" },
      ],
    }),
  );
  assert.equal(receipt.unapplied, "0.00");
  const sale = await transaction(f.actor, (ctx) => checkout(ctx, saleInput));
  assert.ok(sale.id);
  await transaction(f.actor, (ctx) =>
    settleContact(ctx, "supplier", {
      branch_id: f.branchId,
      contact_id: f.supplier.id,
      payment: { method_id: f.bank.id, amount: "150", reference: randomUUID() },
      allocations: [
        { document_id: ap.id, document_type: "opening", amount: "150" },
      ],
    }),
  );
  const customerAdvance = await transaction(f.actor, (ctx) =>
    settleContact(ctx, "customer", {
      branch_id: f.branchId,
      contact_id: f.customer.id,
      payment: { method_id: f.bank.id, amount: "100", reference: randomUUID() },
      allocations: [],
    }),
  );
  const credit = await transaction(f.actor, (ctx) =>
    one(
      ctx,
      "SELECT id FROM advance_credits WHERE company_id=$1 AND source_id=$2",
      [f.companyId, customerAdvance.id],
    ),
  );
  await transaction(f.actor, (ctx) =>
    applyCreditToOpening(ctx, ar.id, {
      credit_id: credit.id,
      amount: "50",
      reason: "Apply already booked customer credit to the legacy debt",
    }),
  );
  const supplierAdvance = await transaction(f.actor, (ctx) =>
    settleContact(ctx, "supplier", {
      branch_id: f.branchId,
      contact_id: f.supplier.id,
      payment: { method_id: f.bank.id, amount: "100", reference: randomUUID() },
      allocations: [],
    }),
  );
  await transaction(f.actor, (ctx) =>
    applyAdvance(ctx, "supplier", {
      source_id: supplierAdvance.id,
      document_id: ap.id,
      document_type: "opening",
      amount: "40",
    }),
  );
  await transaction(f.actor, async (ctx) => {
    const current = await getOpeningBatch(ctx, batch.id);
    assert.equal(
      current.items.find((i: any) => i.id === ar.id).outstanding,
      "350.00",
    );
    assert.equal(
      current.items.find((i: any) => i.id === ap.id).outstanding,
      "210.00",
    );
    assert.equal(
      (
        await one(
          ctx,
          "SELECT md5(to_jsonb(b)::text) AS hash FROM opening_batches b WHERE company_id=$1 AND id=$2",
          [f.companyId, batch.id],
        )
      ).hash,
      snapshot.hash,
    );
    const control = await verifyIntegrity(ctx);
    assert.equal(control.matches, true);
    assert.equal(
      control.controls.find((c) => c.account === "ar")?.subledger,
      "466.00",
    );
    assert.equal(
      control.controls.find((c) => c.account === "ap")?.subledger,
      "210.00",
    );
    assert.equal(
      (await aging(ctx, "customer", { to: f.cutover })).items[0].outstanding,
      "600.00",
    );
    assert.ok(
      (
        await contactStatement(ctx, "customer", f.customer.id, {
          from: f.cutover,
          to: f.today,
        })
      ).items.some((i) => i.source_type === "opening_balance"),
    );
  });
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        reverseOpeningBatch(ctx, batch.id, {
          reason: "Never undo the real receipts/payments already allocated",
        }),
      ),
    (e: any) => e.code === "OPENING_ALREADY_ALLOCATED",
  );
});
test("maker/checker, immutable posted content, exact references, unused reversal and fixed cutover fail closed without overwriting history", async () => {
  const f = await setup(),
    draft = await transaction(f.actor, (ctx) =>
      saveOpeningBatch(ctx, input(f)),
    );
  await transaction(f.actor, (ctx) =>
    transitionOpeningBatch(
      ctx,
      draft.id,
      "submitted",
      "Source documents reviewed before approval",
    ),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        ctx.db.query(
          "UPDATE opening_items SET amount=1 WHERE company_id=$1 AND batch_id=$2",
          [f.companyId, draft.id],
        ),
      ),
    /immutable after submission/,
  );
  await transaction(f.actor, (ctx) =>
    ctx.db.query(
      `UPDATE companies SET settings=settings||'{"allowSelfApproval":false}'::jsonb WHERE id=$1`,
      [f.companyId],
    ),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        postOpeningBatch(
          ctx,
          draft.id,
          "Creator cannot self-authorize by merely calling post",
        ),
      ),
    (e: any) => e.code === "SELF_APPROVAL",
  );
  assert.equal(
    (await transaction(f.actor, (ctx) => openingMetadata(ctx, f.branchId)))
      .cutover,
    null,
  );
  await transaction(f.actor, (ctx) =>
    ctx.db.query(
      `UPDATE companies SET settings=settings||'{"allowSelfApproval":true}'::jsonb WHERE id=$1`,
      [f.companyId],
    ),
  );
  await assert.rejects(
    () =>
      transaction({ ...f.actor, approval_limit: "100" }, (ctx) =>
        postOpeningBatch(
          ctx,
          draft.id,
          "Net offset is not the gross approval value",
        ),
      ),
    (e: any) => e.code === "APPROVAL_LIMIT",
  );
  const body = { reason: "Reviewed source ledger under explicit owner policy" },
    key = randomUUID();
  const post = () =>
    transaction(f.actor, (ctx) =>
      idempotent(ctx, "opening-post-test", key, body, () =>
        postOpeningBatch(ctx, draft.id, body.reason),
      ),
    );
  const b = await post();
  assert.equal((await post()).id, b.id);
  const duplicate = await transaction(f.actor, (ctx) =>
    saveOpeningBatch(ctx, {
      ...input(f, "Duplicate normalized reference"),
      items: input(f).items.map((i) => ({
        ...i,
        reference: i.reference.toLowerCase() + " ",
      })),
    }),
  );
  await transaction(f.actor, (ctx) =>
    transitionOpeningBatch(
      ctx,
      duplicate.id,
      "submitted",
      "Duplicate-reference safeguard regression",
    ),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        postOpeningBatch(
          ctx,
          duplicate.id,
          "Must not import an existing active legacy reference twice",
        ),
      ),
    (e: any) => e.code === "23514",
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        ctx.db.query(
          "DELETE FROM opening_batches WHERE company_id=$1 AND id=$2",
          [f.companyId, b.id],
        ),
      ),
    /cannot be edited or deleted/,
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        reverseOpeningBatch(ctx, b.id, {
          reason:
            "A current-day void followed by backdated replacement would double historical aging",
          accounting_date: f.today,
        }),
      ),
    (e: any) => e.code === "OPENING_REVERSAL_DATE",
  );
  await transaction(f.actor, (ctx) =>
    reverseOpeningBatch(ctx, b.id, {
      reason:
        "Unused incorrect import is reversed at its original cutover, never edited",
    }),
  );
  await transaction(f.actor, async (ctx) => {
    assert.equal((await getOpeningBatch(ctx, b.id)).state, "reversed");
    assert.equal(
      (await aging(ctx, "customer", { to: f.cutover })).items.length,
      0,
    );
    assert.equal(
      (await aging(ctx, "customer", { to: f.today })).items.length,
      0,
    );
    assert.equal((await verifyIntegrity(ctx)).matches, true);
    assert.equal((await openingMetadata(ctx, f.branchId)).cutover, f.cutover);
  });
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        reverseOpeningBatch(ctx, b.id, {
          reason: "Duplicate reversal must not post twice",
        }),
      ),
    (e: any) => e.code === "OPENING_NOT_REVERSIBLE",
  );
  const corrected = await transaction(f.actor, (ctx) =>
    saveOpeningBatch(ctx, input(f, "Corrected unused import")),
  );
  await transaction(f.actor, (ctx) =>
    transitionOpeningBatch(
      ctx,
      corrected.id,
      "submitted",
      "Correction reviewed",
    ),
  );
  await transaction(f.actor, (ctx) =>
    postOpeningBatch(
      ctx,
      corrected.id,
      "New corrected batch uses the same permanent cutover",
    ),
  );
  await transaction(f.actor, async (ctx) => {
    const historical = await aging(ctx, "customer", { to: f.cutover });
    assert.equal(historical.items.length, 1);
    assert.equal(historical.items[0].outstanding, "600.00");
    assert.equal(
      (await balanceSheet(ctx, { to: f.cutover })).difference,
      "0.00",
    );
  });
  const wrongDate = await transaction(f.actor, (ctx) =>
    saveOpeningBatch(ctx, {
      ...input(f, "Date cannot move after cutover"),
      accounting_date: f.today,
      items: input(f).items.map((i) => ({
        ...i,
        reference: i.reference + "-NEW",
      })),
    }),
  );
  await transaction(f.actor, (ctx) =>
    transitionOpeningBatch(
      ctx,
      wrongDate.id,
      "submitted",
      "Date boundary safeguard",
    ),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        postOpeningBatch(
          ctx,
          wrongDate.id,
          "Cannot reset the branch boundary after use",
        ),
      ),
    (e: any) => e.code === "OPENING_CUTOVER_FIXED",
  );
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        await postJournal(ctx, {
          branchId: f.branchId,
          date: f.cutover,
          sourceType: "customer_receipt",
          sourceId: randomUUID(),
          description: "Raw old-date debt posting must fail",
          lines: [
            { account: "bank", debit: "1" },
            {
              account: "customer_advances",
              credit: "1",
              customerId: f.customer.id,
            },
          ],
        });
        throw Object.assign(new Error("Missing boundary guard"), {
          code: "PROBE_GUARD_MISSING",
        });
      }),
    (e: any) => e.code === "23514",
  );
});
test("opening allocations serialize last debt and branch cutover races never admit an overlapping operational debt journal", async () => {
  const f = await setup(),
    b = await posted(f),
    item = b.items.find((i: any) => i.kind === "customer");
  const attempt = () =>
    transaction(f.actor, (ctx) =>
      settleContact(ctx, "customer", {
        branch_id: f.branchId,
        contact_id: f.customer.id,
        payment: {
          method_id: f.bank.id,
          amount: "400",
          reference: randomUUID(),
        },
        allocations: [
          { document_id: item.id, document_type: "opening", amount: "400" },
        ],
      }),
    );
  const race = await Promise.allSettled([attempt(), attempt()]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(race.filter((r) => r.status === "rejected").length, 1);
  const foreign = await fixture();
  await assert.rejects(
    () => transaction(foreign.actor, (ctx) => getOpeningBatch(ctx, b.id)),
    (e: any) => e.status === 404,
  );
  await assert.rejects(
    () =>
      transaction({ ...f.actor, branch_ids: [] }, (ctx) =>
        getOpeningBatch(ctx, b.id),
      ),
    (e: any) => e.code === "BRANCH_FORBIDDEN",
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        settleContact(ctx, "customer", {
          branch_id: f.branchId,
          contact_id: f.customer.id,
          accounting_date: f.cutover,
          payment: {
            method_id: f.bank.id,
            amount: "1",
            reference: randomUUID(),
          },
          allocations: [
            { document_id: item.id, document_type: "opening", amount: "1" },
          ],
        }),
      ),
    (e: any) => e.code === "ALLOCATION_DATE_KIND",
  );
  await transaction(f.actor, async (ctx) =>
    assert.equal((await verifyIntegrity(ctx)).matches, true),
  );
  const g = await setup(),
    draft = await transaction(g.actor, (ctx) =>
      saveOpeningBatch(ctx, { ...input(g), accounting_date: g.today }),
    );
  await transaction(g.actor, (ctx) =>
    transitionOpeningBatch(
      ctx,
      draft.id,
      "submitted",
      "Deliberate same-day cutover race",
    ),
  );
  const operations = await Promise.allSettled([
    transaction(g.actor, (ctx) =>
      postOpeningBatch(
        ctx,
        draft.id,
        "Opening posting competes with the first same-date receipt",
      ),
    ),
    transaction(g.actor, (ctx) =>
      settleContact(ctx, "customer", {
        branch_id: g.branchId,
        contact_id: g.customer.id,
        payment: { method_id: g.bank.id, amount: "1", reference: randomUUID() },
        allocations: [],
      }),
    ),
  ]);
  assert.equal(
    operations.filter((r) => r.status === "fulfilled").length,
    1,
    "Exactly one boundary winner; the other must roll back",
  );
  await transaction(g.actor, async (ctx) =>
    assert.equal((await verifyIntegrity(ctx)).matches, true),
  );
});

test("database requires exact AR/AP/equity-only source journals and prevents operational supplier invoice duplication", async () => {
  const f = await setup(),
    draft = await transaction(f.actor, (ctx) =>
      saveOpeningBatch(ctx, input(f)),
    );
  await transaction(f.actor, (ctx) =>
    transitionOpeningBatch(
      ctx,
      draft.id,
      "submitted",
      "Raw source-binding regression",
    ),
  );
  const mark = (ctx: any) =>
    ctx.db.query(
      "UPDATE opening_batches SET status='posted',posted_by=$1,posted_at=now(),approval_reason='Raw guard probe only' WHERE company_id=$2 AND id=$3",
      [f.actor.id, f.companyId, draft.id],
    );
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        await mark(ctx);
      }),
    (e: any) => e.code === "23514" && e.message.includes("journal missing"),
  );
  assert.equal(
    (await transaction(f.actor, (ctx) => openingMetadata(ctx, f.branchId)))
      .cutover,
    null,
  );
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        await mark(ctx);
        await postJournal(ctx, {
          branchId: f.branchId,
          date: f.cutover,
          sourceType: "opening_balance",
          sourceId: draft.id,
          description: "Opening may not manufacture cash or turnover",
          lines: [
            { account: "bank", debit: "1" },
            { account: "sales", credit: "1" },
          ],
        });
      }),
    (e: any) =>
      e.code === "23514" && e.message.includes("cash, stock, revenue or tax"),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        const other = await saveContact(
          ctx,
          "customer",
          customerSchema.parse({
            name: "Wrong dimension",
            code: "WRONG",
            credit_limit: "0",
          }),
        );
        await mark(ctx);
        await postJournal(ctx, {
          branchId: f.branchId,
          date: f.cutover,
          sourceType: "opening_balance",
          sourceId: draft.id,
          description: "A balanced total with the wrong party must fail",
          lines: [
            { account: "ar", debit: "600", customerId: other.id },
            { account: "ap", credit: "400", supplierId: f.supplier.id },
            { account: "equity", credit: "200" },
          ],
        });
      }),
    (e: any) => e.code === "23514" && e.message.includes("party journal"),
  );
  await transaction(f.actor, (ctx) =>
    postOpeningBatch(
      ctx,
      draft.id,
      "The service now posts the exact reviewed party dimensions",
    ),
  );
  const {
    createPurchaseOrder,
    transitionPurchaseOrder,
    receiveGoods,
    recognizeSupplierInvoice,
  } = await import("../../apps/api/src/services/procurement.ts");
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
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
        const p = await createProduct(
          ctx,
          productSchema.parse({
            name: "Duplicate legacy reference probe",
            sku: "DUPREF",
            unit_id: unit.id,
            tax_rule_id: tax.id,
            price: "116",
          }),
        );
        const po = await createPurchaseOrder(ctx, {
          supplier_id: f.supplier.id,
          warehouse_id: f.warehouseId,
          lines: [{ product_id: p.id, quantity: "1", unit_cost: "10" }],
        });
        await transitionPurchaseOrder(
          ctx,
          po.id,
          "submitted",
          "Reviewed duplicate reference probe",
        );
        await transitionPurchaseOrder(
          ctx,
          po.id,
          "approved",
          "Explicit test owner approval",
        );
        const grn = await receiveGoods(ctx, {
          order_id: po.id,
          lines: [
            {
              order_line_id: po.lines[0].id,
              quantity: "1",
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
        await recognizeSupplierInvoice(ctx, {
          receipt_id: grn.id,
          supplier_reference: " old-ap-001 ",
          due_date: f.today,
          lines: [{ receipt_line_id: line.id, net: "10", tax_rule_id: tax.id }],
        });
      }),
    (e: any) => e.code === "23514" && e.message.includes("already imported"),
  );
  await transaction(f.actor, async (ctx) =>
    assert.equal((await verifyIntegrity(ctx)).matches, true),
  );
});

test("opening legacy credits become real allocatable advances, settle imported debt and block consumed reversal", async () => {
  const f = await setup();
  const postedBatch = await (async () => {
    const b = await transaction(f.actor, (ctx) =>
      saveOpeningBatch(ctx, {
        branch_id: f.branchId,
        accounting_date: f.cutover,
        reference: "Legacy debt and advance carry-forward",
        items: [
          {
            kind: "customer" as const,
            contact_code: "LEG-C",
            reference: "OLD-AR-001",
            original_date: "2025-01-01",
            due_date: "2025-01-31",
            amount: "600",
          },
          {
            kind: "customer" as const,
            direction: "credit" as const,
            contact_code: "LEG-C",
            reference: "OLD-CR-900",
            original_date: "2025-01-02",
            due_date: "2025-01-31",
            amount: "150",
            description: "Unapplied legacy customer prepayment",
          },
          {
            kind: "supplier" as const,
            contact_id: f.supplier.id,
            reference: "OLD-AP-001",
            due_date: "2025-02-01",
            amount: "400",
          },
          {
            kind: "supplier" as const,
            direction: "credit" as const,
            contact_id: f.supplier.id,
            reference: "OLD-AD-700",
            due_date: "2025-02-01",
            amount: "220",
            description: "Advance already paid to the legacy supplier",
          },
        ],
      }),
    );
    await transaction(f.actor, (ctx) =>
      transitionOpeningBatch(
        ctx,
        b.id,
        "submitted",
        "Reviewed both legacy remainders",
      ),
    );
    return transaction(f.actor, (ctx) =>
      postOpeningBatch(
        ctx,
        b.id,
        "Explicit owner approval of reviewed debt and advance carry-forward",
      ),
    );
  })();
  assert.equal(postedBatch.receivables, "600.00");
  assert.equal(postedBatch.payables, "400.00");
  assert.equal(postedBatch.customer_credits, "150.00");
  assert.equal(postedBatch.supplier_credits, "220.00");
  const arItem = postedBatch.items.find(
      (i: any) => i.kind === "customer" && i.direction === "debt",
    ),
    crItem = postedBatch.items.find(
      (i: any) => i.kind === "customer" && i.direction === "credit",
    ),
    apItem = postedBatch.items.find(
      (i: any) => i.kind === "supplier" && i.direction === "debt",
    ),
    adItem = postedBatch.items.find(
      (i: any) => i.kind === "supplier" && i.direction === "credit",
    );
  assert.equal(crItem.credit_available, "150.00");
  assert.equal(adItem.credit_available, "220.00");
  await transaction(f.actor, async (ctx) => {
    const composition = (
      await ctx.db.query(
        "SELECT a.system_key AS scope,coalesce(l.customer_id,l.supplier_id) AS party,sum(l.debit)::text AS dr,sum(l.credit)::text AS cr FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=$1 AND j.source_type='opening_balance' AND j.source_id=$2 GROUP BY 1,2 ORDER BY 1 NULLS LAST,2",
        [f.companyId, postedBatch.id],
      )
    ).rows;
    assert.deepEqual(
      composition.map((r: any) => [r.scope, r.dr, r.cr]),
      [
        ["ap", "0.00", "400.00"],
        ["ar", "600.00", "0.00"],
        ["customer_advances", "0.00", "150.00"],
        ["equity", "0.00", "270.00"],
        ["supplier_advances", "220.00", "0.00"],
      ],
    );
    for (const r of composition.filter((r: any) => r.scope !== "equity"))
      assert.ok(r.party);
    const credits = (
      await ctx.db.query(
        "SELECT c.*,(c.amount-coalesce((SELECT sum(u.amount) FROM advance_uses u WHERE u.company_id=c.company_id AND u.credit_id=c.id),0))::text AS available FROM advance_credits c WHERE c.company_id=$1 AND c.source_type='opening_balance' ORDER BY c.amount",
        [f.companyId],
      )
    ).rows;
    assert.equal(credits.length, 2);
    assert.equal(credits[0].available, "150.00");
    assert.equal(credits[0].customer_id, f.customer.id);
    assert.equal(credits[0].source_id, crItem.id);
    assert.equal(credits[0].accounting_date.toISOString().slice(0, 10), f.cutover);
    assert.equal(credits[1].available, "220.00");
    assert.equal(credits[1].supplier_id, f.supplier.id);
    assert.equal(credits[1].source_id, adItem.id);
    assert.equal(
      (await balanceSheet(ctx, { to: f.cutover })).difference,
      "0.00",
    );
    assert.equal(
      (await profitAndLoss(ctx, { from: f.cutover, to: f.cutover })).net_profit,
      "0.00",
    );
    const tax = await taxSummary(ctx, { from: f.cutover, to: f.cutover });
    assert.equal(tax.output_tax, "0.00");
    assert.equal(tax.input_tax, "0.00");
    const debtAging = await aging(ctx, "customer", { to: f.cutover });
    assert.equal(debtAging.items.length, 1);
    assert.equal(debtAging.items[0].document_type, "opening");
    assert.equal(debtAging.items[0].outstanding, "600.00");
    const suppAging = await aging(ctx, "supplier", { to: f.cutover });
    assert.equal(suppAging.items.length, 1);
    assert.equal(suppAging.items[0].outstanding, "400.00");
  });
  const custAdvanceId = await transaction(f.actor, (ctx) =>
      one(
        ctx,
        "SELECT id FROM advance_credits WHERE company_id=$1 AND source_type='opening_balance' AND customer_id IS NOT NULL",
        [f.companyId],
      ).then((r) => r.id),
    ),
    suppAdvanceId = await transaction(f.actor, (ctx) =>
      one(
        ctx,
        "SELECT id FROM advance_credits WHERE company_id=$1 AND source_type='opening_balance' AND supplier_id IS NOT NULL",
        [f.companyId],
      ).then((r) => r.id),
    );
  const settledAr = await transaction(f.actor, (ctx) =>
      applyCreditToOpening(ctx, arItem.id, {
        credit_id: custAdvanceId,
        amount: "80",
        accounting_date: f.today,
        reason: "Apply legacy customer prepayment to its old debt",
      }),
    ),
    settledAp = await transaction(f.actor, (ctx) =>
      applyCreditToOpening(ctx, apItem.id, {
        credit_id: suppAdvanceId,
        amount: "120",
        accounting_date: f.today,
        reason: "Apply legacy supplier advance to its old payable",
      }),
    );
  assert.equal(settledAr.outstanding, "520.00");
  assert.equal(settledAp.outstanding, "280.00");
  await transaction(f.actor, async (ctx) => {
    const availability = (
      await ctx.db.query(
        "SELECT source_id,(amount-coalesce((SELECT sum(u.amount) FROM advance_uses u WHERE u.company_id=c.company_id AND u.credit_id=c.id),0))::text AS available FROM advance_credits c WHERE c.company_id=$1 AND c.source_type='opening_balance' ORDER BY amount",
        [f.companyId],
      )
    ).rows;
    assert.equal(availability[0].available, "70.00");
    assert.equal(availability[1].available, "100.00");
    const cashCash = await one(
      ctx,
      "SELECT count(*)::int AS n FROM payments WHERE company_id=$1",
      [f.companyId],
    );
    assert.equal(cashCash.n, 0, "credit allocation must never move cash");
    assert.equal(
      (await balanceSheet(ctx, { to: f.today })).difference,
      "0.00",
    );
  });
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        reverseOpeningBatch(ctx, postedBatch.id, {
          reason: "A batch with settled debt is history, not a draft",
        }),
      ),
    (e: any) =>
      e.code === "OPENING_ALREADY_ALLOCATED" ||
      /settled items/i.test(e.message ?? ""),
  );
  // A batch whose credits were consumed elsewhere carries no opening
  // allocations of its own: it must still be reversal-proof via the
  // dedicated consumed-credit guard, not the debt-settlement one.
  const second = await (async () => {
      const b0 = await transaction(f.actor, (ctx) =>
        saveOpeningBatch(ctx, {
          branch_id: f.branchId,
          accounting_date: f.cutover,
          reference: "Second legacy advance remainder",
          items: [
            {
              kind: "customer" as const,
              direction: "credit" as const,
              contact_code: "LEG-C",
              reference: "OLD-CR-901",
              due_date: "2025-01-31",
              amount: "90",
            },
          ],
        }),
      ),
      third = await transaction(f.actor, (ctx) =>
        saveOpeningBatch(ctx, {
          branch_id: f.branchId,
          accounting_date: f.cutover,
          reference: "Second legacy debt remainder",
          items: [
            {
              kind: "customer" as const,
              contact_code: "LEG-C",
              reference: "OLD-AR-777",
              due_date: "2025-01-31",
              amount: "30",
            },
          ],
        }),
      );
    for (const b of [b0, third]) {
      await transaction(f.actor, (ctx) =>
        transitionOpeningBatch(ctx, b.id, "submitted", "Reviewed second pair"),
      );
      await transaction(f.actor, (ctx) =>
        postOpeningBatch(ctx, b.id, "Approved second pair"),
      );
    }
    return { second: b0, third };
  })();
  await transaction(f.actor, async (ctx) => {
    const c2item = (
        await getOpeningBatch(ctx, second.second.id)
      ).items.find((i: any) => i.direction === "credit"),
      c2credit = await one(
        ctx,
        "SELECT id FROM advance_credits WHERE company_id=$1 AND source_type='opening_balance' AND source_id=$2",
        [f.companyId, c2item.id],
      ),
      dItem = (await getOpeningBatch(ctx, second.third.id)).items.find(
        (i: any) => i.direction === "debt",
      );
    const used = await applyCreditToOpening(ctx, dItem.id, {
      credit_id: c2credit.id,
      amount: "30",
      accounting_date: f.today,
      reason: "Consume the second batch's credit on the third batch's debt",
    });
    assert.equal(used.outstanding, "0.00");
    await assert.rejects(
      () => reverseOpeningBatch(ctx, second.second.id, { reason: "Retry" }),
      (e: any) => e.code === "OPENING_CREDIT_CONSUMED",
    );
  });
  await transaction(f.actor, async (ctx) =>
    assert.equal((await verifyIntegrity(ctx)).matches, true),
  );
});

test("unused legacy credits reverse append-only at the original cutover and withdraw availability", async () => {
  const f = await setup();
  const batch = await (async () => {
    const b = await transaction(f.actor, (ctx) =>
      saveOpeningBatch(ctx, {
        branch_id: f.branchId,
        accounting_date: f.cutover,
        reference: "Legacy remainder imported under the wrong file",
        items: [
          {
            kind: "customer" as const,
            contact_code: "LEG-C",
            reference: "OLD-AR-001",
            due_date: "2025-01-31",
            amount: "600",
          },
          {
            kind: "customer" as const,
            direction: "credit" as const,
            contact_code: "LEG-C",
            reference: "OLD-CR-900",
            due_date: "2025-01-31",
            amount: "150",
          },
          {
            kind: "supplier" as const,
            direction: "credit" as const,
            contact_id: f.supplier.id,
            reference: "OLD-AD-700",
            due_date: "2025-02-01",
            amount: "220",
          },
        ],
      }),
    );
    await transaction(f.actor, (ctx) =>
      transitionOpeningBatch(ctx, b.id, "submitted", "Reviewed then disputed"),
    );
    return transaction(f.actor, (ctx) =>
      postOpeningBatch(
        ctx,
        b.id,
        "Owner approval under the test self-approval policy",
      ),
    );
  })();
  const reversed = await transaction(f.actor, (ctx) =>
    reverseOpeningBatch(ctx, batch.id, {
      reason:
        "Wrong legacy file imported; no debt settlement or credit application happened",
    }),
  );
  assert.equal(reversed.state, "reversed");
  await transaction(f.actor, async (ctx) => {
    const withdrawal = (
      await ctx.db.query(
        "SELECT u.target_type,u.amount::text FROM advance_uses u JOIN advance_credits c ON c.company_id=u.company_id AND c.id=u.credit_id JOIN journals j ON j.company_id=u.company_id AND j.source_type='opening_balance_reversal' AND j.source_id=u.target_id WHERE u.company_id=$1 ORDER BY u.amount",
        [f.companyId],
      )
    ).rows;
    assert.deepEqual(
      withdrawal.map((r: any) => [r.target_type, r.amount]),
      [
        ["opening_reversal", "150.00"],
        ["opening_reversal", "220.00"],
      ],
    );
    const availability = (
      await ctx.db.query(
        "SELECT (amount-coalesce((SELECT sum(u.amount) FROM advance_uses u WHERE u.company_id=c.company_id AND u.credit_id=c.id),0))::text AS available FROM advance_credits c WHERE c.company_id=$1 AND c.source_type='opening_balance' ORDER BY amount",
        [f.companyId],
      )
    ).rows;
    assert.deepEqual(
      availability.map((r: any) => r.available),
      ["0.00", "0.00"],
    );
    const composition = (
      await ctx.db.query(
        "SELECT a.system_key AS scope,sum(l.debit)::text AS dr,sum(l.credit)::text AS cr FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=$1 AND j.source_type='opening_balance_reversal' GROUP BY 1 ORDER BY 1 NULLS LAST",
        [f.companyId],
      )
    ).rows;
    assert.deepEqual(
      composition.map((r: any) => [r.scope, r.dr, r.cr]),
      [
        ["ar", "0.00", "600.00"],
        ["customer_advances", "150.00", "0.00"],
        ["equity", "670.00", "0.00"],
        ["supplier_advances", "0.00", "220.00"],
      ],
    );
    assert.equal(
      (await balanceSheet(ctx, { to: f.cutover })).difference,
      "0.00",
    );
  });
  const restated = await (async () => {
    const b = await transaction(f.actor, (ctx) =>
      saveOpeningBatch(ctx, {
        branch_id: f.branchId,
        accounting_date: f.cutover,
        reference: "Corrected legacy remainder for the same cutover",
        items: [
          {
            kind: "customer" as const,
            contact_code: "LEG-C",
            reference: "OLD-AR-001",
            due_date: "2025-01-31",
            amount: "540",
          },
        ],
      }),
    );
    await transaction(f.actor, (ctx) =>
      transitionOpeningBatch(ctx, b.id, "submitted", "Replacement draft"),
    );
    return transaction(f.actor, (ctx) =>
      postOpeningBatch(ctx, b.id, "Approval of the corrected replacement"),
    );
  })();
  assert.equal(restated.receivables, "540.00");
  await transaction(f.actor, async (ctx) =>
    assert.equal((await verifyIntegrity(ctx)).matches, true),
  );
});

test("opening credits: direction validation, direction-scoped duplicates and exact advance-account source guard", async () => {
  const { openingItemSchema } = await import("@duka/shared");
  assert.throws(() =>
    openingItemSchema.parse({
      kind: "customer",
      direction: "gift",
      contact_code: "X",
      reference: "R-1",
      due_date: "2026-01-01",
      amount: "1",
    }),
  );
  assert.equal(
    openingItemSchema.parse({
      kind: "customer",
      contact_code: "X",
      reference: "R-1",
      due_date: "2026-01-01",
      amount: "1",
    }).direction,
    "debt",
  );
  const f = await setup();
  const postItems = async (items: any[], reference: string) => {
    const b = await transaction(f.actor, (ctx) =>
      saveOpeningBatch(ctx, {
        branch_id: f.branchId,
        accounting_date: f.cutover,
        reference,
        items,
      }),
    );
    await transaction(f.actor, (ctx) =>
      transitionOpeningBatch(ctx, b.id, "submitted", "Reviewed duplication"),
    );
    return transaction(f.actor, (ctx) =>
      postOpeningBatch(ctx, b.id, "Approved duplication semantics probe"),
    );
  };
  const debtBatch = await postItems(
    [
      {
        kind: "customer",
        contact_code: "LEG-C",
        reference: "OLD-DUP-1",
        due_date: "2025-01-31",
        amount: "10",
      },
    ],
    "Legacy debt file",
  );
  assert.ok(debtBatch.id);
  const creditBatch = await postItems(
    [
      {
        kind: "customer",
        direction: "credit",
        contact_code: "LEG-C",
        reference: "OLD-DUP-1",
        due_date: "2025-01-31",
        amount: "10",
        description:
          "A same-named debt and advance remainder are different economies",
      },
    ],
    "Legacy advance file",
  );
  assert.ok(creditBatch.id);
  const dup = await transaction(f.actor, (ctx) =>
      saveOpeningBatch(ctx, {
        branch_id: f.branchId,
        accounting_date: f.cutover,
        reference: "Accidentally re-scanned legacy debt file",
        items: [
          {
            kind: "customer",
            contact_code: "LEG-C",
            reference: "old-dup-1",
            due_date: "2025-01-31",
            amount: "12",
          },
        ],
      }),
    );
  await transaction(f.actor, (ctx) =>
    transitionOpeningBatch(ctx, dup.id, "submitted", "Rescan probe"),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        postOpeningBatch(ctx, dup.id, "Duplicate direction must fail"),
      ),
    (e: any) => /already imported/.test(e.message ?? ""),
  );
  const draft = await transaction(f.actor, (ctx) =>
      saveOpeningBatch(ctx, {
        branch_id: f.branchId,
        accounting_date: f.cutover,
        reference: "Raw advance guard probe",
        items: [
          {
            kind: "customer",
            contact_code: "LEG-C",
            reference: "OLD-AR-77",
            due_date: "2025-01-31",
            amount: "50",
          },
        ],
      }),
    );
  await transaction(f.actor, (ctx) =>
    transitionOpeningBatch(ctx, draft.id, "submitted", "Raw guard probe"),
  );
  const mark = (ctx: any) =>
    ctx.db.query(
      "UPDATE opening_batches SET status='posted',posted_by=$1,posted_at=now(),approval_reason='Raw guard probe only' WHERE company_id=$2 AND id=$3",
      [f.actor.id, f.companyId, draft.id],
    );
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        await mark(ctx);
        await postJournal(ctx, {
          branchId: f.branchId,
          date: f.cutover,
          sourceType: "opening_balance",
          sourceId: draft.id,
          description:
            "An advance account that does not match imported debt directions must fail",
          lines: [
            {
              account: "customer_advances",
              credit: "50",
              customerId: f.customer.id,
            },
            { account: "equity", debit: "50" },
          ],
        });
      }),
    (e: any) => e.code === "23514" && e.message.includes("party journal"),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        await mark(ctx);
        await postJournal(ctx, {
          branchId: f.branchId,
          date: f.cutover,
          sourceType: "opening_balance",
          sourceId: draft.id,
          description: "Opening still may not manufacture cash or turnover",
          lines: [
            { account: "bank", debit: "1" },
            { account: "sales", credit: "1" },
          ],
        });
      }),
    (e: any) =>
      e.code === "23514" && e.message.includes("cash, stock, revenue or tax"),
  );
  await transaction(f.actor, (ctx) =>
    postOpeningBatch(ctx, draft.id, "The service posts exact dimensions"),
  );
  await transaction(f.actor, async (ctx) =>
    assert.equal((await verifyIntegrity(ctx)).matches, true),
  );
});
