import { D, money, sum, assertTransition } from "@duka/shared";
import { randomUUID } from "node:crypto";
import {
  one,
  fail,
  branchAccess,
  warehouseAccess,
  requirePermission,
  requireOneOf,
  has,
  audit,
  accountingDate,
  type Context,
} from "../db.ts";
import { postJournal } from "@duka/accounting";
import { validateShift } from "./payments.ts";
export async function checkApproval(
  ctx: Context,
  creator: string,
  amount: string,
  reason?: string,
) {
  if (D(amount).gt(ctx.actor.approval_limit))
    fail(403, "APPROVAL_LIMIT", "This amount exceeds your approval limit");
  if (creator === ctx.actor.id) {
    const c = await one(ctx, "SELECT settings FROM companies WHERE id=$1", [
      ctx.companyId,
    ]);
    if (!c.settings.allowSelfApproval)
      fail(
        403,
        "SELF_APPROVAL",
        "A different authorized user must approve this transaction",
      );
    if (!reason || reason.length < 5)
      fail(422, "REASON_REQUIRED", "Self-approval requires an explicit reason");
  }
}
export async function openShift(
  ctx: Context,
  input: { register_id: string; opening_float: string },
) {
  requirePermission(ctx, "shifts.open");
  const register = await one(
    ctx,
    "SELECT * FROM registers WHERE company_id=$1 AND id=$2 AND active FOR UPDATE",
    [ctx.companyId, input.register_id],
  );
  branchAccess(ctx, register.branch_id);
  await warehouseAccess(ctx, register.warehouse_id);
  const id = randomUUID();
  await ctx.db.query(
    "INSERT INTO shifts(id,company_id,register_id,branch_id,cashier_id,opening_float) VALUES($1,$2,$3,$4,$5,$6)",
    [
      id,
      ctx.companyId,
      register.id,
      register.branch_id,
      ctx.actor.id,
      input.opening_float,
    ],
  );
  await audit(ctx, "open", "shift", id, null, input);
  return {
    id,
    status: "open",
    opening_float: input.opening_float,
    register_id: register.id,
  };
}
export async function expectedShift(ctx: Context, id: string) {
  requireOneOf(ctx, ["shifts.open", "shifts.review", "shifts.manage"]);
  const s = await one(
    ctx,
    "SELECT * FROM shifts WHERE company_id=$1 AND id=$2",
    [ctx.companyId, id],
  );
  branchAccess(ctx, s.branch_id);
  if (
    s.cashier_id !== ctx.actor.id &&
    !has(ctx, "shifts.review") &&
    !has(ctx, "shifts.manage")
  )
    fail(403, "SHIFT_OWNER", "Shift is private to its cashier and managers");
  const r = await ctx.db.query(
    `SELECT m.id,m.name,m.kind,coalesce(sum(CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END),0)::text AS movement FROM payment_methods m LEFT JOIN payments p ON p.company_id=m.company_id AND p.method_id=m.id AND p.shift_id=$2 AND NOT EXISTS(SELECT 1 FROM expense_voids v WHERE v.company_id=p.company_id AND v.payment_id=p.id) WHERE m.company_id=$1 GROUP BY m.id ORDER BY m.kind,m.name,m.id`,
    [ctx.companyId, id],
  );
  const cashMoves = (
    await ctx.db.query(
      "SELECT coalesce(sum(CASE WHEN direction='in' THEN amount ELSE -amount END),0)::text AS n FROM cash_movements WHERE company_id=$1 AND shift_id=$2",
      [ctx.companyId, id],
    )
  ).rows[0].n;
  let first = true;
  const methods = r.rows.map((m) => {
    let expected = D(m.movement);
    if (m.kind === "cash" && first) {
      expected = expected.plus(s.opening_float).plus(cashMoves);
      first = false;
    }
    return { ...m, expected: money(expected) };
  });
  return {
    ...s,
    methods,
    expected_cash: money(
      sum(methods.filter((m) => m.kind === "cash").map((m) => m.expected)),
    ),
  };
}
export async function closeShift(
  ctx: Context,
  id: string,
  input: {
    counts: Record<string, string>;
    denominations?: Record<string, number>;
  },
) {
  requirePermission(ctx, "shifts.open");
  const current = await one(
    ctx,
    "SELECT * FROM shifts WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  if (current.cashier_id !== ctx.actor.id)
    fail(403, "SHIFT_OWNER", "Only the cashier can submit their shift");
  branchAccess(ctx, current.branch_id);
  try {
    assertTransition("shift", current.status, "submitted");
  } catch (e: any) {
    fail(409, "INVALID_STATE", e.message);
  }
  const s = await expectedShift(ctx, id);
  const ids = s.methods.map((m: any) => m.id);
  if (Object.keys(input.counts).some((k) => !ids.includes(k)))
    fail(422, "UNKNOWN_PAYMENT_METHOD", "Unknown payment method in count");
  const actualCash = sum(
    s.methods
      .filter((m: any) => m.kind === "cash")
      .map((m: any) => input.counts[m.id] ?? "0"),
  );
  if (input.denominations) {
    const allowed = [
      "0.5",
      "1",
      "5",
      "10",
      "20",
      "40",
      "50",
      "100",
      "200",
      "500",
      "1000",
    ];
    if (Object.keys(input.denominations).some((k) => !allowed.includes(k)))
      fail(422, "DENOMINATION", "Unknown denomination");
    const total = sum(
      Object.entries(input.denominations).map(([d, n]) =>
        D(d).times(n).toString(),
      ),
    );
    if (!total.eq(actualCash))
      fail(
        422,
        "DENOMINATION_TOTAL",
        "Denominations do not match the cash count",
      );
  }
  const expected = Object.fromEntries(
      s.methods.map((m: any) => [m.id, m.expected]),
    ),
    variance = money(actualCash.minus(s.expected_cash));
  await ctx.db.query(
    "UPDATE shifts SET status='submitted',closed_at=now(),counts=$1,expected=$2,denominations=$3,variance=$4 WHERE company_id=$5 AND id=$6",
    [
      JSON.stringify(input.counts),
      JSON.stringify(expected),
      JSON.stringify(input.denominations ?? {}),
      variance,
      ctx.companyId,
      id,
    ],
  );
  await audit(
    ctx,
    "submit",
    "shift",
    id,
    { status: current.status },
    { counts: input.counts, expected, variance },
  );
  return { id, status: "submitted", expected, counts: input.counts, variance };
}
export async function reviewShift(
  ctx: Context,
  id: string,
  status: "approved" | "rejected",
  reason: string,
) {
  requirePermission(ctx, "shifts.review");
  const s = await one(
    ctx,
    "SELECT * FROM shifts WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, s.branch_id);
  try {
    assertTransition("shift", s.status, status);
  } catch (e: any) {
    fail(409, "INVALID_STATE", e.message);
  }
  await checkApproval(
    ctx,
    s.cashier_id,
    money(D(s.variance ?? 0).abs()),
    reason,
  );
  if (status === "approved") {
    const details = await expectedShift(ctx, id);
    for (const m of details.methods) {
      if (
        m.kind !== "cash" &&
        !D(s.counts?.[m.id] ?? 0).eq(s.expected?.[m.id] ?? 0)
      )
        fail(
          409,
          "PAYMENT_RECONCILIATION_REQUIRED",
          "Resolve non-cash variances before approving the shift",
        );
    }
    if (!D(s.variance).eq(0)) {
      const date = await accountingDate(ctx),
        cash = (
          await ctx.db.query(
            "SELECT account_id FROM payment_methods WHERE company_id=$1 AND kind='cash' ORDER BY name,id LIMIT 1",
            [ctx.companyId],
          )
        ).rows[0];
      const shortage = D(s.variance).lt(0),
        v = money(D(s.variance).abs());
      await postJournal(ctx, {
        branchId: s.branch_id,
        date,
        sourceType: "shift_variance",
        sourceId: id,
        description: `Cashier variance: ${reason}`,
        lines: shortage
          ? [
              { account: "cash_variance", debit: v },
              { account: cash.account_id, byId: true, credit: v },
            ]
          : [
              { account: cash.account_id, byId: true, debit: v },
              { account: "cash_variance", credit: v },
            ],
      });
    }
  }
  await ctx.db.query(
    "UPDATE shifts SET status=$1,reviewed_by=$2,review_reason=$3 WHERE company_id=$4 AND id=$5",
    [status, ctx.actor.id, reason, ctx.companyId, id],
  );
  await audit(
    ctx,
    status,
    "shift",
    id,
    { status: s.status },
    { status, variance: s.variance },
    reason,
  );
  return { id, status, variance: s.variance };
}
export async function cashMovement(
  ctx: Context,
  input: {
    shift_id: string;
    direction: "in" | "out";
    amount: string;
    account_id: string;
    reason: string;
  },
) {
  requirePermission(ctx, "shifts.manage");
  const date = await accountingDate(ctx);
  const s = await one(
    ctx,
    "SELECT * FROM shifts WHERE company_id=$1 AND id=$2",
    [ctx.companyId, input.shift_id],
  );
  await validateShift(ctx, s.id, s.branch_id);
  const a = await one(
    ctx,
    "SELECT * FROM accounts WHERE company_id=$1 AND id=$2 AND active",
    [ctx.companyId, input.account_id],
  );
  if (
    [
      "cash",
      "mpesa",
      "card",
      "ar",
      "ap",
      "inventory",
      "tax_output",
      "tax_input",
      "grni",
      "customer_advances",
      "supplier_advances",
      "refund_payable",
    ].includes(a.system_key)
  )
    fail(
      422,
      "CONTROL_ACCOUNT",
      "Use the relevant business workflow for control accounts",
    );
  const details = await expectedShift(ctx, s.id);
  if (input.direction === "out" && D(input.amount).gt(details.expected_cash))
    fail(409, "CASH_INSUFFICIENT", "Cash-out exceeds expected physical cash");
  const cash = await one(
    ctx,
    "SELECT account_id FROM payment_methods WHERE company_id=$1 AND kind='cash' AND active ORDER BY name,id LIMIT 1",
    [ctx.companyId],
  );
  const id = randomUUID();
  await ctx.db.query(
    "INSERT INTO cash_movements(id,company_id,shift_id,direction,amount,reason,account_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      id,
      ctx.companyId,
      s.id,
      input.direction,
      input.amount,
      input.reason,
      input.account_id,
      ctx.actor.id,
    ],
  );
  await postJournal(ctx, {
    branchId: s.branch_id,
    date,
    sourceType: "cash_movement",
    sourceId: id,
    description: input.reason,
    lines:
      input.direction === "in"
        ? [
            { account: cash.account_id, byId: true, debit: input.amount },
            { account: input.account_id, byId: true, credit: input.amount },
          ]
        : [
            { account: input.account_id, byId: true, debit: input.amount },
            { account: cash.account_id, byId: true, credit: input.amount },
          ],
  });
  await audit(ctx, "post", "cash_movement", id, null, input, input.reason);
  return { id, ...input };
}
