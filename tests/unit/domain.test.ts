import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateLine,
  D,
  money,
  canTransition,
  checkoutSchema,
} from "@duka/shared";
import { defaultRoles } from "@duka/shared";
import { validateJournal } from "@duka/accounting";
import { weightedReceipt, weightedIssue } from "@duka/inventory";
import { totp, verifyTotp } from "../../apps/api/src/services/auth.ts";

test("inclusive VAT extracts net without floating-point drift", () => {
  assert.deepEqual(
    calculateLine({
      quantity: "3",
      price: "116",
      taxRate: "16",
      inclusive: true,
    }),
    { net: "300.00", tax: "48.00", total: "348.00", discount: "0.00" },
  );
});
test("exclusive VAT and compound discounts round once at line boundary", () => {
  const l = calculateLine({
    quantity: "2.5",
    price: "100",
    lineDiscount: "10",
    transactionDiscount: "5",
    taxRate: "16",
    inclusive: false,
  });
  assert.deepEqual(l, {
    net: "213.75",
    tax: "34.20",
    total: "247.95",
    discount: "36.25",
  });
});
test("zero and exempt tax price arithmetic is exact", () => {
  assert.equal(
    calculateLine({
      quantity: "0.125",
      price: "12.34",
      taxRate: 0,
      inclusive: true,
    }).total,
    "1.54",
  );
  assert.equal(money(D("0.1").plus("0.2")), "0.30");
});
test("invalid negative quantity and over-discount fail", () => {
  assert.throws(() =>
    calculateLine({
      quantity: "-1",
      price: "1",
      taxRate: "16",
      inclusive: true,
    }),
  );
  assert.throws(() =>
    calculateLine({
      quantity: 1,
      price: 1,
      taxRate: 0,
      inclusive: false,
      lineDiscount: 101,
    }),
  );
});
test("weighted average preserves exact value and consumes final remainder", () => {
  const b = weightedReceipt("3", "10.00", "2", "4");
  assert.equal(b.quantity, "5.000000");
  assert.equal(b.value, "18.00");
  assert.equal(b.average, "3.600000");
  const a = weightedIssue("3", "10.00", "1");
  assert.equal(a.issuedValue, "3.33");
  const end = weightedIssue(a.quantity, a.value, "2");
  assert.equal(end.issuedValue, "6.67");
  assert.equal(end.value, "0.00");
});
test("stock reservations and overselling are fail-closed", () => {
  assert.throws(() => weightedIssue("2", "20", "3"));
  assert.throws(() => weightedIssue("2", "20", "2", "1"));
});
test("journals balance and prohibit ambiguous or fractional-cent lines", () => {
  assert.equal(
    validateJournal([{ debit: "116" }, { credit: "100" }, { credit: "16" }]),
    "116.00",
  );
  assert.throws(() => validateJournal([{ debit: "1" }, { credit: "0.99" }]));
  assert.throws(() => validateJournal([{ debit: "1", credit: "1" }]));
  assert.throws(() =>
    validateJournal([{ debit: "0.001" }, { credit: "0.001" }]),
  );
});
test("finalized workflow transitions cannot repeat", () => {
  assert.equal(canTransition("purchase_order", "draft", "approved"), false);
  assert.equal(canTransition("purchase_order", "submitted", "approved"), true);
  assert.equal(canTransition("shift", "approved", "open"), false);
  assert.equal(canTransition("expense", "posted", "approved"), false);
});
test("checkout rejects client-provided totals, actor and tenant", () => {
  assert.equal(
    checkoutSchema.safeParse({ total: "1", user_id: "x", company_id: "y" })
      .success,
    false,
  );
});
test("POS live-quote gate: empty payments quoted, unfinished decimals refused", () => {
  const register = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const product = "8d0f778a-8536-41ef-a55c-f18fd2091bf8";
  const base = {
    register_id: register,
    lines: [{ product_id: product, quantity: "1" }],
    payments: [] as never[],
  };
  // The POS prices carts over /pos/price with no payments yet; the shared
  // schema must keep accepting that shape or the live quote silently dies.
  assert.equal(
    checkoutSchema.safeParse({ ...base, discount_percent: "0" }).success,
    true,
  );
  // Keystroke-transient values the operator has not finished typing must
  // stay invalid so the client can skip the request instead of 422-spamming.
  for (const draft of ["5.", "5..5", "-5", "5.0.0", "abc", "5e2"])
    assert.equal(
      checkoutSchema.safeParse({ ...base, discount_percent: draft }).success,
      false,
      `transient discount ${draft} must remain schema-invalid`,
    );
});
test("TOTP matches RFC 6238 SHA1 vector and replay is rejected", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totp(secret, 1), "287082");
  const code = totp(secret),
    step = verifyTotp(secret, code);
  assert.ok(step !== null);
  assert.equal(verifyTotp(secret, code, Number(step) + 1), null);
});
test("default Cashier role can sell on credit within policy, overrides stay privileged", () => {
  const cashier = defaultRoles.Cashier;
  assert.ok(
    cashier.includes("sales.credit"),
    "cashiers must be able to leave a balance on a customer account",
  );
  assert.ok(
    !cashier.includes("sales.credit_override"),
    "credit-limit overrides require management",
  );
  assert.ok(
    !cashier.includes("settings.manage") &&
      !cashier.includes("accounting.post"),
    "cashier scope stays minimal elsewhere",
  );
});
