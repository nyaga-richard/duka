import { fixture } from "./helper.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction, one } from "../../apps/api/src/db.ts";
import {
  createExpense,
  reviewExpense,
  payExpense,
  acquireAsset,
  depreciateAsset,
  disposeAsset,
  voidExpense,
  reclassifyExpense,
} from "../../apps/api/src/services/business.ts";
import { refundExpense } from "../../apps/api/src/services/expense-refunds.ts";
import { openShift, expectedShift } from "../../apps/api/src/services/shifts.ts";
import { postJournal } from "@duka/accounting";
import { verifyIntegrity } from "../../apps/api/src/services/integrity.ts";
import {
  balanceSheet,
  profitAndLoss,
} from "../../apps/api/src/services/reports.ts";
after(() => pool.end());

async function paidExpenseFlow(opts: { shiftBound?: boolean } = {}) {
  const f = await fixture();
  return transaction(f.actor, async (ctx) => {
    await ctx.db.query(
      `UPDATE companies SET settings=settings||'{"allowSelfApproval":true}'::jsonb WHERE id=$1`,
      [f.companyId],
    );
    const category = await one(
        ctx,
        "SELECT * FROM expense_categories WHERE company_id=$1 LIMIT 1",
        [f.companyId],
      ),
      tax = await one(
        ctx,
        "SELECT id FROM tax_rules WHERE company_id=$1 AND code='VAT16'",
        [f.companyId],
      );
    const methods = (
        await ctx.db.query(
          "SELECT * FROM payment_methods WHERE company_id=$1",
          [f.companyId],
        )
      ).rows,
      bank = methods.find((m) => m.kind === "bank"),
      cash = methods.find((m) => m.kind === "cash");
    const today = (
        await one(
          ctx,
          "SELECT to_char(now() AT TIME ZONE timezone,'YYYY-MM-DD') AS date FROM companies WHERE id=$1",
          [f.companyId],
        )
      ).date,
      yesterday = (await one(ctx, "SELECT ($1::date-1)::text AS date", [today]))
        .date;
    await postJournal(ctx, {
      branchId: f.branchId,
      date: yesterday,
      sourceType: "opening",
      sourceId: randomUUID(),
      description: "Correction test drawer/bank funding",
      lines: [
        { account: "bank", debit: "2000" },
        { account: "cash", debit: "800" },
        { account: "equity", credit: "2800" },
      ],
    });
    const shift = await openShift(ctx, {
      register_id: f.registerId,
      opening_float: "800",
    });
    const expense = await createExpense(ctx, {
      branch_id: f.branchId,
      category_id: category.id,
      tax_rule_id: tax.id,
      net: "100",
      description: "Paid expense that turns out to be a pure entry error",
      accounting_date: yesterday,
    });
    await reviewExpense(
      ctx,
      expense.id,
      "approved",
      "Owner-approved test expense",
    );
    await payExpense(ctx, expense.id, {
      accounting_date: yesterday,
      shift_id: opts.shiftBound ? shift.id : undefined,
      payment: {
        method_id: opts.shiftBound ? cash.id : bank.id,
        amount: expense.total,
        reference: randomUUID(),
      },
    });
    return {
      ...f,
      ctx: undefined,
      category,
      tax,
      bank,
      cash,
      shift,
      expense,
      today,
      yesterday,
    };
  });
}

test("no-transfer expense void restores the register, P&L and balance sheet as though the entry never existed", async () => {
  const f = await paidExpenseFlow({ shiftBound: true });
  const before = await transaction(f.actor, async (ctx) => {
    const s = await expectedShift(ctx, f.shift.id),
      cashRow = s.methods.find((m: any) => m.kind === "cash"),
      bs = await balanceSheet(ctx, { branches: [f.branchId] }),
      pl = await profitAndLoss(ctx, {
        branches: [f.branchId],
        from: f.yesterday,
        to: f.today,
      });
    return { cashRow, bs, pl };
  });
  // 800 float − 116 erroneous expense out.
  assert.equal(before.cashRow.expected, "684.00");
  const bankLine = before.bs.assets.find((a: any) => a.system_key === "bank"),
    cashLine = before.bs.assets.find((a: any) => a.system_key === "cash");
  assert.equal(bankLine.amount, "2000.00");
  assert.equal(cashLine.amount, "684.00");
  const plExpenses = before.pl.expenses.find(
    (e: any) => e.system_key === "expenses",
  );
  assert.equal(plExpenses.amount, "100.00");

  const voided = await transaction(f.actor, (ctx) =>
    voidExpense(ctx, f.expense.id, {
      reason: "Duplicate entry: the transfer was never really made",
    }),
  );
  assert.ok(voided.number.startsWith("EXPV"));

  await transaction(f.actor, async (ctx) => {
    assert.equal(
      (
        await one(
          ctx,
          "SELECT status FROM expenses WHERE company_id=$1 AND id=$2",
          [f.companyId, f.expense.id],
        )
      ).status,
      "void",
    );
    const v = await one(
      ctx,
      "SELECT * FROM expense_voids WHERE company_id=$1 AND expense_id=$2",
      [f.companyId, f.expense.id],
    );
    assert.equal(
      v.accounting_date instanceof Date
        ? v.accounting_date.toISOString().slice(0, 10)
        : String(v.accounting_date).slice(0, 10),
      f.yesterday,
    );
    // The reversal journal carries tender-debit at the original date.
    const lines = await ctx.db.query(
      `SELECT a.system_key,sum(l.debit-l.credit)::text AS net FROM journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE j.company_id=$1 AND j.source_type='expense_void' AND j.source_id=$2 GROUP BY a.system_key`,
      [f.companyId, v.id],
    );
    const byKey = Object.fromEntries(
      lines.rows.map((r) => [r.system_key, r.net]),
    );
    assert.equal(byKey.cash, "116.00");
    assert.equal(byKey.expenses, "-100.00");
    assert.equal(byKey.tax_input, "-16.00");
    // Register treats the erroneous payment as never made.
    const s = await expectedShift(ctx, f.shift.id);
    assert.equal(
      s.methods.find((m: any) => m.kind === "cash").expected,
      "800.00",
    );
    const bs = await balanceSheet(ctx, { branches: [f.branchId] });
    assert.equal(
      bs.assets.find((a: any) => a.system_key === "cash").amount,
      "800.00",
    );
    const pl = await profitAndLoss(ctx, {
      branches: [f.branchId],
      from: f.yesterday,
      to: f.today,
    });
    assert.equal(
      pl.expenses.find((e: any) => e.system_key === "expenses").amount,
      "0.00",
    );
    assert.equal(
      (await verifyIntegrity(ctx)).matches,
      true,
    );
  });
  // A second void and a refund of a voided expense are both impossible.
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        voidExpense(ctx, f.expense.id, { reason: "Second attempt must fail" }),
      ),
    (e: any) => e.code === "EXPENSE_NOT_POSTED",
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        refundExpense(ctx, f.expense.id, {
          amount: "10",
          payment: { method_id: f.bank.id, reference: randomUUID() },
          reason: "Refund of a voided expense must be rejected",
        }),
      ),
  );
});

test("reclassification moves posted net between expense accounts with exact caps and exclusive correction axes", async () => {
  const f = await paidExpenseFlow();
  const target = await transaction(f.actor, async (ctx) => {
    const t = await one(
      ctx,
      "INSERT INTO accounts(company_id,code,name,type) VALUES($1,'6997','Repairs and maintenance','expense') RETURNING id",
      [f.companyId],
    );
    return t.id;
  });
  const first = await transaction(f.actor, (ctx) =>
    reclassifyExpense(ctx, f.expense.id, {
      to_account_id: target,
      amount: "40",
      reason: "Part of this voucher was actually repairs, not general spend",
      accounting_date: f.today,
    }),
  );
  assert.ok(first.number.startsWith("EXPRC"));
  // Cap enforcement: 60 remain.
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        reclassifyExpense(ctx, f.expense.id, {
          to_account_id: target,
          amount: "61",
          reason: "Over the remaining posted net must be refused",
          accounting_date: f.today,
        }),
      ),
    (e: any) => e.code === "23514",
  );
  // Correction axes are exclusive: no refund or void once reclassification
  // began. Each DB-guard rejection runs in its own transaction.
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        refundExpense(ctx, f.expense.id, {
          amount: "10",
          payment: { method_id: f.bank.id, reference: randomUUID() },
          reason: "Refund after reclassification must be refused",
        }),
      ),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        voidExpense(ctx, f.expense.id, {
          reason: "Void after reclassification must be refused",
        }),
      ),
    (e: any) => e.code === "23514",
  );
  await transaction(f.actor, (ctx) =>
    reclassifyExpense(ctx, f.expense.id, {
      to_account_id: target,
      amount: "60",
      reason: "Move the remainder correctly",
      accounting_date: f.today,
    }),
  );
  await transaction(f.actor, async (ctx) => {
    const pl = await profitAndLoss(ctx, {
      branches: [f.branchId],
      from: f.yesterday,
      to: f.today,
    });
    assert.equal(
      pl.expenses.find((e: any) => e.system_key === "expenses").amount,
      "0.00",
    );
    const repairs = pl.expenses.find((e: any) => e.id === target);
    assert.equal(repairs.amount, "100.00");
    assert.equal((await verifyIntegrity(ctx)).matches, true);
  });
});

test("paid acquisition, monthly depreciation and final disposal with loss, gain and scrap are exact", async () => {
  const f = await fixture();
  const scope = await transaction(f.actor, async (ctx) => {
    await ctx.db.query(
      `UPDATE companies SET settings=settings||'{"allowSelfApproval":true}'::jsonb WHERE id=$1`,
      [f.companyId],
    );
    const bank = (
        await ctx.db.query(
          "SELECT * FROM payment_methods WHERE company_id=$1 AND kind='bank'",
          [f.companyId],
        )
      ).rows[0],
      cash = (
        await ctx.db.query(
          "SELECT * FROM payment_methods WHERE company_id=$1 AND kind='cash'",
          [f.companyId],
        )
      ).rows[0];
    const today = (
        await one(
          ctx,
          "SELECT to_char(now() AT TIME ZONE timezone,'YYYY-MM-DD') AS date FROM companies WHERE id=$1",
          [f.companyId],
        )
      ).date,
      d90 = (await one(ctx, "SELECT ($1::date-90)::text AS d", [today])).d,
      d60 = (await one(ctx, "SELECT ($1::date-60)::text AS d", [today])).d,
      d30 = (await one(ctx, "SELECT ($1::date-30)::text AS d", [today])).d;
    await postJournal(ctx, {
      branchId: f.branchId,
      date: d90,
      sourceType: "opening",
      sourceId: randomUUID(),
      description: "Asset test funding",
      lines: [
        { account: "bank", debit: "5000" },
        { account: "cash", debit: "2000" },
        { account: "equity", credit: "7000" },
      ],
    });
    return { bank, cash, today, d90, d60, d30 };
  });
  const asset = await transaction(f.actor, (ctx) =>
    acquireAsset(ctx, {
      branch_id: f.branchId,
      name: "Delivery motorcycle",
      cost: "1200",
      residual: "0",
      useful_months: 12,
      acquired_date: scope.d90,
      funding: "payment",
      tax: "192",
      payment: {
        method_id: scope.bank.id,
        amount: "1392",
        reference: randomUUID(),
      },
    }),
  );
  assert.equal(asset.funding, "payment");
  await transaction(f.actor, async (ctx) => {
    const bs = await balanceSheet(ctx, { branches: [f.branchId] });
    assert.equal(
      bs.assets.find((a: any) => a.system_key === "fixed_assets").amount,
      "1200.00",
    );
    assert.equal(
      bs.assets.find((a: any) => a.system_key === "tax_input").amount,
      "192.00",
    );
    assert.equal(
      bs.assets.find((a: any) => a.system_key === "bank").amount,
      "3608.00",
    );
  });
  // Tender mismatch is rejected outright.
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        acquireAsset(ctx, {
          branch_id: f.branchId,
          name: "Ghost generator",
          cost: "900",
          residual: "0",
          useful_months: 12,
          acquired_date: scope.d90,
          funding: "payment",
          tax: "0",
          payment: {
            method_id: scope.bank.id,
            amount: "899",
            reference: randomUUID(),
          },
        }),
      ),
  );
  const run1 = await transaction(f.actor, (ctx) =>
      depreciateAsset(ctx, asset.id, scope.d60),
    ),
    run2 = await transaction(f.actor, (ctx) =>
      depreciateAsset(ctx, asset.id, scope.d30),
    );
  assert.equal(run1.amount, "100.00");
  assert.equal(run2.amount, "100.00");
  // Cash proceeds require an open shift, like every real drawer movement.
  const assetShift = await transaction(f.actor, (ctx) =>
    openShift(ctx, { register_id: f.registerId, opening_float: "800" }),
  );
  // Disposal below book value: loss, incoming tender recorded.
  const disposed = await transaction(f.actor, (ctx) =>
    disposeAsset(ctx, asset.id, {
      proceeds: "800",
      reason: "Sold the motorcycle below book value for drawer cash",
      accounting_date: scope.today,
      shift_id: assetShift.id,
      payment: {
        method_id: scope.cash.id,
        amount: "800",
        reference: randomUUID(),
      },
    }),
  );
  assert.equal(disposed.loss, "200.00");
  assert.equal(disposed.gain, "0.00");
  assert.equal(disposed.net_book_value, "1000.00");
  await transaction(f.actor, async (ctx) => {
    const bs = await balanceSheet(ctx, { branches: [f.branchId] });
    assert.equal(
      bs.assets.find((a: any) => a.system_key === "fixed_assets").amount,
      "0.00",
    );
    const pl = await profitAndLoss(ctx, {
      branches: [f.branchId],
      from: scope.d90,
      to: scope.today,
    });
    assert.equal(
      pl.expenses.find((e: any) => e.system_key === "asset_disposal_loss").amount,
      "200.00",
    );
  });
  // Terminal state: no further disposal or depreciation, register immutable.
  // Each rejection owns its transaction; DB errors abort enclosing ones.
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        disposeAsset(ctx, asset.id, {
          proceeds: "0",
          reason: "Second disposal must fail",
          accounting_date: scope.today,
        }),
      ),
    (e: any) => e.code === "ASSET_DISPOSED",
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) => depreciateAsset(ctx, asset.id, scope.today)),
    (e: any) => e.code === "23514" || e.code === "FULLY_DEPRECIATED",
  );
  await assert.rejects(() =>
    transaction(f.actor, (ctx) =>
      ctx.db.query(
        "UPDATE fixed_assets SET name='Rewritten history' WHERE company_id=$1 AND id=$2",
        [f.companyId, asset.id],
      ),
    ),
  );
  // Gain disposal and full scrap on opening-funded assets.
  const opening = await transaction(f.actor, (ctx) =>
    acquireAsset(ctx, {
      branch_id: f.branchId,
      name: "Shelving unit",
      cost: "400",
      residual: "40",
      useful_months: 9,
      acquired_date: scope.d30,
    }),
  );
  const gained = await transaction(f.actor, (ctx) =>
    disposeAsset(ctx, opening.id, {
      proceeds: "500",
      reason: "Sold shelving above book value",
      accounting_date: scope.today,
      payment: {
        method_id: scope.bank.id,
        amount: "500",
        reference: randomUUID(),
      },
    }),
  );
  assert.equal(gained.gain, "100.00");
  const scrap = await transaction(f.actor, async (ctx) => {
    const a = await acquireAsset(ctx, {
      branch_id: f.branchId,
      name: "Broken fridge",
      cost: "300",
      residual: "0",
      useful_months: 12,
      acquired_date: scope.d30,
    });
    return disposeAsset(ctx, a.id, {
      proceeds: "0",
      reason: "Scrapped beyond repair, no proceeds",
      accounting_date: scope.today,
    });
  });
  assert.equal(scrap.loss, "300.00");
  await transaction(f.actor, async (ctx) => {
    const bs = await balanceSheet(ctx, { branches: [f.branchId] });
    assert.equal(
      bs.assets.find((a: any) => a.system_key === "fixed_assets").amount,
      "0.00",
    );
    const pl2 = await profitAndLoss(ctx, {
      branches: [f.branchId],
      from: scope.d90,
      to: scope.today,
    });
    assert.equal(
      pl2.income.find((e: any) => e.system_key === "asset_disposal_gain")
        .amount,
      "100.00",
    );
    assert.equal((await verifyIntegrity(ctx)).matches, true);
  });
});
