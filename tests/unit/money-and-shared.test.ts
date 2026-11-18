import test from "node:test";
import assert from "node:assert/strict";
import {
  D,
  money,
  normalizeKenyanPhone,
  slugify,
  moneyString,
  kenyanPhone,
} from "@ecom/shared";
import {
  stableStringify,
  idempotencyHash,
} from "../../apps/api/src/http/route.ts";

test("money rounds half-up to two decimals and always returns a string", () => {
  assert.equal(money("12.345"), "12.35");
  assert.equal(money(0), "0.00");
  assert.equal(money(D("1.005")), "1.01");
  assert.equal(typeof money(5), "string");
});

test("moneyString accepts decimals but rejects floats-as-numbers and negatives", () => {
  assert.equal(moneyString.parse("1250"), "1250.00");
  assert.equal(moneyString.parse(" 99.90 "), "99.90");
  assert.throws(() => moneyString.parse("12.345"));
  assert.throws(() => moneyString.parse("-5"));
  assert.throws(() => moneyString.parse(12.5));
});

test("Kenyan phone numbers normalise to +254", () => {
  assert.equal(normalizeKenyanPhone("0712 345 678"), "+254712345678");
  assert.equal(normalizeKenyanPhone("+254712345678"), "+254712345678");
  assert.equal(normalizeKenyanPhone("254712345678"), "+254712345678");
  assert.equal(normalizeKenyanPhone("0112345678"), "+254112345678");
  assert.equal(normalizeKenyanPhone("0812345678"), null);
  assert.equal(kenyanPhone.parse("0712-345-678"), "+254712345678");
});

test("slugify produces stable url-safe identifiers", () => {
  assert.equal(slugify("Kanzu Shirt — Black/M"), "kanzu-shirt-black-m");
  assert.equal(slugify("   "), "");
});

test("stable request hashing ignores key order but not values", () => {
  const a = stableStringify({ b: 1, a: [{ y: 2, x: 1 }] });
  const b = stableStringify({ a: [{ x: 1, y: 2 }], b: 1 });
  assert.equal(a, b);
  assert.equal(idempotencyHash({ a: 1 }), idempotencyHash({ a: 1 }));
  assert.notEqual(idempotencyHash({ a: 1 }), idempotencyHash({ a: 2 }));
});
