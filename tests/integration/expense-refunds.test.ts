import { fixture } from "./helper.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction, one, idempotent } from "../../apps/api/src/db.ts";
import {
  createExpense,
  reviewExpense,
  payExpense,
} from "../../apps/api/src/services/business.ts";
import {
  refundExpense,
  reverseExpenseRefund,
  getExpense,
} from "../../apps/api/src/services/expense-refunds.ts";
import {
  openShift,
  expectedShift,
  cashMovement,
} from "../../apps/api/src/services/shifts.ts";
import { recordPayment } from "../../apps/api/src/services/payments.ts";
import { postJournal } from "@duka/accounting";
import { verifyIntegrity } from "../../apps/api/src/services/integrity.ts";
import {
  balanceSheet,
  profitAndLoss,
  dashboard,
} from "../../apps/api/src/services/reports.ts";
after(() => pool.end());
async function paidExpense(net = "100") {
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
      date: today,
      sourceType: "opening",
      sourceId: randomUUID(),
      description: "Explicit expense refund test bank/drawer funding",
      lines: [
        { account: "bank", debit: "1000" },
        { account: "cash", debit: "500" },
        { account: "equity", credit: "1500" },
      ],
    });
    const shift = await openShift(ctx, {
      register_id: f.registerId,
      opening_float: "500",
    });
    const expense = await createExpense(ctx, {
      branch_id: f.branchId,
      category_id: category.id,
      tax_rule_id: tax.id,
      net,
      description: "Auditable paid expense for refund regression",
      accounting_date: yesterday,
    });
    await reviewExpense(
      ctx,
      expense.id,
      "approved",
      "Explicit owner approval under the test self-approval policy",
    );
    await payExpense(ctx, expense.id, {
      accounting_date: today,
      payment: {
        method_id: bank.id,
        amount: expense.total,
        reference: randomUUID(),
      },
    });
    return {
      ...f,
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
test("expense refund and actual repayment preserve original voucher, net/VAT and account snapshots despite later category edits", async () => {
  const f = await paidExpense();
  const snapshot = await transaction(f.actor, async (ctx) => {
    const original = await one(
      ctx,
      "SELECT md5(to_jsonb(e)::text) AS hash FROM expenses e WHERE company_id=$1 AND id=$2",
      [f.companyId, f.expense.id],
    );
    const replacement = await one(
      ctx,
      "INSERT INTO accounts(company_id,code,name,type) VALUES($1,'6998','Changed future expense category','expense') RETURNING id",
      [f.companyId],
    );
    await ctx.db.query(
      "UPDATE expense_categories SET account_id=$1 WHERE company_id=$2 AND id=$3",
      [replacement.id, f.companyId, f.category.id],
    );
    assert.equal(
      (await dashboard(ctx, { from: f.today, to: f.today })).totals.expenses,
      "116.00",
    );
    return { ...original, replacement: replacement.id };
  });
  const input = {
      amount: "30.25",
      payment: { method_id: f.bank.id, reference: randomUUID() },
      reason: "Actual supplier expense refund matched to the bank statement",
    },
    key = randomUUID();
  const first = await transaction(f.actor, (ctx) =>
    idempotent(ctx, "expense-refund-test", key, input, () =>
      refundExpense(ctx, f.expense.id, input),
    ),
  );
  const replay = await transaction(f.actor, (ctx) =>
    idempotent(ctx, "expense-refund-test", key, input, () =>
      refundExpense(ctx, f.expense.id, input),
    ),
  );
  assert.equal(replay.id, first.id);
  assert.equal(first.net, "26.08");
  assert.equal(first.tax, "4.17");
  assert.equal(first.remaining, "85.75");
  await transaction(f.actor, async (ctx) => {
    const refund = await one(
      ctx,
      "SELECT expense_account_id FROM expense_refunds WHERE company_id=$1 AND id=$2",
      [f.companyId, first.id],
    );
    assert.equal(refund.expense_account_id, f.category.account_id);
    assert.notEqual(refund.expense_account_id, snapshot.replacement);
    const report = await verifyIntegrity(ctx);
    assert.equal(report.matches, true);
    assert.equal(
      report.controls.find((c) => c.account === "posted_expense_net")
        ?.general_ledger,
      "73.92",
    );
  });
  await transaction(f.actor, (ctx) =>
    reverseExpenseRefund(ctx, first.id, {
      shift_id: f.shift.id,
      payment: { method_id: f.cash.id },
      reason: "Actual cash repayment returns the earlier expense refund",
    }),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        reverseExpenseRefund(ctx, first.id, {
          payment: { method_id: f.bank.id, reference: randomUUID() },
          reason: "Duplicate repayment must never post",
        }),
      ),
    (e: any) => e.code === "ALREADY_REVERSED",
  );
  await transaction(f.actor, (ctx) =>
    refundExpense(ctx, f.expense.id, {
      amount: "116",
      payment: { method_id: f.bank.id, reference: randomUUID() },
      reason: "Full actual refund received after the earlier repayment",
    }),
  );
  await transaction(f.actor, async (ctx) => {
    const e = await getExpense(ctx, f.expense.id);
    assert.equal(e.refunded, "116.00");
    assert.equal(e.remaining, "0.00");
    assert.equal(e.status, "posted");
    assert.equal(e.posting_date, f.today);
    assert.equal(
      (
        await one(
          ctx,
          "SELECT md5(to_jsonb(e)::text) AS hash FROM expenses e WHERE company_id=$1 AND id=$2",
          [f.companyId, f.expense.id],
        )
      ).hash,
      snapshot.hash,
    );
    assert.equal(
      (await expectedShift(ctx, f.shift.id)).expected_cash,
      "469.75",
    );
    assert.equal(
      (await dashboard(ctx, { from: f.today, to: f.today })).totals.expenses,
      "0.00",
    );
    assert.equal(
      (await profitAndLoss(ctx, { from: f.today, to: f.today })).net_profit,
      "0.00",
    );
    assert.equal((await balanceSheet(ctx, {})).difference, "0.00");
    assert.equal((await verifyIntegrity(ctx)).matches, true);
    assert.equal(e.refunds.length, 3);
  });
  const { businessPdf } = await import(
    "../../apps/api/src/services/documents.ts"
  );
  const pdf = await transaction(f.actor, (ctx) =>
    businessPdf(ctx, "expense-refund", first.id),
  );
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        ctx.db.query(
          "UPDATE expense_refunds SET net='0' WHERE company_id=$1 AND id=$2",
          [f.companyId, first.id],
        ),
      ),
    /immutable|cannot|posted/i,
  );
});
test("cent-level refund allocation and out-of-order repayments never over-credit net or VAT and final depletion is exact", async () => {
  const f = await paidExpense("0.04");
  assert.equal(f.expense.total, "0.05");
  const refunds: Awaited<ReturnType<typeof refundExpense>>[] = [];
  for (let i = 0; i < 5; i++)
    refunds.push(
      await transaction(f.actor, (ctx) =>
        refundExpense(ctx, f.expense.id, {
          amount: "0.01",
          payment: { method_id: f.bank.id, reference: randomUUID() },
          reason: "Actual cent-level bank refund allocation regression",
        }),
      ),
    );
  assert.equal(refunds[4].net, "0.00");
  assert.equal(refunds[4].tax, "0.01");
  await transaction(f.actor, (ctx) =>
    reverseExpenseRefund(ctx, refunds[0].id, {
      payment: { method_id: f.bank.id, reference: randomUUID() },
      reason: "Actual repayment of a non-latest partial refund",
    }),
  );
  const restored = await transaction(f.actor, (ctx) =>
    refundExpense(ctx, f.expense.id, {
      amount: "0.01",
      payment: { method_id: f.bank.id, reference: randomUUID() },
      reason: "Actual refund restores exact original net allocation",
    }),
  );
  assert.equal(restored.net, "0.01");
  assert.equal(restored.tax, "0.00");
  await transaction(f.actor, (ctx) =>
    reverseExpenseRefund(ctx, refunds[4].id, {
      payment: { method_id: f.bank.id, reference: randomUUID() },
      reason: "Actual repayment of the tax-only rounding remainder",
    }),
  );
  const taxRemainder = await transaction(f.actor, (ctx) =>
    refundExpense(ctx, f.expense.id, {
      amount: "0.01",
      payment: { method_id: f.bank.id, reference: randomUUID() },
      reason: "Final actual refund clears exact original VAT remainder",
    }),
  );
  assert.equal(taxRemainder.net, "0.00");
  assert.equal(taxRemainder.tax, "0.01");
  await transaction(f.actor, async (ctx) => {
    const e = await getExpense(ctx, f.expense.id);
    assert.equal(e.remaining, "0.00");
    assert.equal((await verifyIntegrity(ctx)).matches, true);
    assert.equal((await profitAndLoss(ctx, {})).net_profit, "0.00");
  });
});
test("expense refund races, database multirow overdraw, scope, approval/date/period and cash repayment limits fail closed", async () => {
  const f = await paidExpense(),
    attempt = () =>
      transaction(f.actor, (ctx) =>
        refundExpense(ctx, f.expense.id, {
          amount: "80",
          payment: { method_id: f.bank.id, reference: randomUUID() },
          reason: "Concurrent actual bank refund regression",
        }),
      );
  const results = await Promise.allSettled([attempt(), attempt()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const first = (
    results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>
  ).value;
  const small = {
    amount: "1",
    payment: { method_id: f.bank.id, reference: randomUUID() },
    reason: "Authorization and chronology boundary regression",
  };
  await assert.rejects(
    () =>
      transaction({ ...f.actor, branch_ids: [] }, (ctx) =>
        refundExpense(ctx, f.expense.id, small),
      ),
    (e: any) => e.code === "BRANCH_FORBIDDEN",
  );
  await assert.rejects(
    () =>
      transaction(
        {
          ...f.actor,
          permissions: f.actor.permissions.filter(
            (p) => p !== "expenses.approve",
          ),
        },
        (ctx) => refundExpense(ctx, f.expense.id, small),
      ),
    (e: any) => e.status === 403,
  );
  await assert.rejects(
    () =>
      transaction({ ...f.actor, approval_limit: "0.50" }, (ctx) =>
        refundExpense(ctx, f.expense.id, small),
      ),
    (e: any) => e.code === "APPROVAL_LIMIT",
  );
  await transaction(f.actor, (ctx) =>
    ctx.db.query(
      `UPDATE companies SET settings=settings||'{"allowSelfApproval":false}'::jsonb WHERE id=$1`,
      [f.companyId],
    ),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) => refundExpense(ctx, f.expense.id, small)),
    (e: any) => e.code === "SELF_APPROVAL",
  );
  await transaction(f.actor, (ctx) =>
    ctx.db.query(
      `UPDATE companies SET settings=settings||'{"allowSelfApproval":true}'::jsonb WHERE id=$1`,
      [f.companyId],
    ),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        refundExpense(ctx, f.expense.id, {
          ...small,
          accounting_date: f.yesterday,
        }),
      ),
    (e: any) => e.code === "EXPENSE_REFUND_DATE_ORDER",
  );
  const other = await fixture();
  await assert.rejects(
    () =>
      transaction(other.actor, (ctx) =>
        refundExpense(ctx, f.expense.id, small),
      ),
    (e: any) => e.status === 404,
  );
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        const rows: { id: string; payment_id: string; number: string }[] = [];
        for (let i = 0; i < 2; i++) {
          const id = randomUUID(),
            payment = await recordPayment(
              ctx,
              { method_id: f.bank.id, amount: "20", reference: randomUUID() },
              {
                branchId: f.branchId,
                sourceType: "expense_refund",
                sourceId: id,
                direction: "in",
                date: f.today,
              },
            );
          rows.push({ id, payment_id: payment.id, number: randomUUID() });
        }
        const tax = (
          await one(
            ctx,
            "SELECT id FROM accounts WHERE company_id=$1 AND system_key='tax_input'",
            [f.companyId],
          )
        ).id;
        await ctx.db.query(
          `INSERT INTO expense_refunds(id,company_id,expense_id,branch_id,number,kind,amount,net,tax,expense_account_id,tax_account_id,payment_id,accounting_date,reason,created_by) VALUES($1,$7,$8,$9,$3,'refund',20,17.24,2.76,$10,$11,$5,$12,'Raw same-command over-refund probe',$13),($2,$7,$8,$9,$4,'refund',20,17.24,2.76,$10,$11,$6,$12,'Raw same-command over-refund probe',$13)`,
          [
            rows[0].id,
            rows[1].id,
            rows[0].number,
            rows[1].number,
            rows[0].payment_id,
            rows[1].payment_id,
            f.companyId,
            f.expense.id,
            f.branchId,
            f.category.account_id,
            tax,
            f.today,
            f.actor.id,
          ],
        );
        throw Object.assign(new Error("Missing refund cap"), {
          code: "PROBE_GUARD_MISSING",
        });
      }),
    (e: any) => e.code === "23514",
  );
  await transaction(f.actor, (ctx) =>
    cashMovement(ctx, {
      shift_id: f.shift.id,
      direction: "out",
      amount: "450",
      account_id: f.bank.account_id,
      reason: "Actual drawer deposit to bank before repayment",
    }),
  );
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        reverseExpenseRefund(ctx, first.id, {
          shift_id: f.shift.id,
          payment: { method_id: f.cash.id },
          reason: "Repayment cannot exceed available actual drawer cash",
        }),
      ),
    (e: any) => e.code === "CASH_INSUFFICIENT",
  );
  await transaction(f.actor, async (ctx) => {
    assert.equal((await getExpense(ctx, f.expense.id)).remaining, "36.00");
    assert.equal((await verifyIntegrity(ctx)).matches, true);
    assert.equal((await expectedShift(ctx, f.shift.id)).expected_cash, "50.00");
    await ctx.db.query(
      "UPDATE accounting_periods SET status='closed' WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date",
      [f.companyId, f.today],
    );
  });
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) => refundExpense(ctx, f.expense.id, small)),
    (e: any) => e.code === "PERIOD_CLOSED",
  );
});
