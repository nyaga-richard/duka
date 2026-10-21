import { fixture } from "./helper.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction, one } from "../../apps/api/src/db.ts";
import { createIntent } from "../../apps/api/src/integrations/mpesa.ts";

after(() => pool.end());

test("same idempotency key returns the original intent instead of firing twice", async () => {
  const f = await fixture();
  const key = "pay-" + randomUUID();
  const first = await transaction(f.actor, (ctx) =>
    createIntent(ctx, {
      branch_id: f.branchId,
      amount: "116",
      phone: "254712345678",
      idempotency_key: key,
    }),
  );
  const replay = await transaction(f.actor, (ctx) =>
    createIntent(ctx, {
      branch_id: f.branchId,
      amount: "116",
      phone: "254712345678",
      idempotency_key: key,
    }),
  );
  assert.equal(replay.id, first.id);
  assert.equal(replay.deduplicated, true);
  const rows = await transaction(f.actor, (ctx) =>
    one(
      ctx,
      "SELECT count(*)::int AS n FROM payment_intents WHERE company_id=$1 AND idempotency_key=$2",
      [f.companyId, key],
    ),
  );
  assert.equal(rows.n, 1);
  const dispatch = await transaction(f.actor, (ctx) =>
    one(
      ctx,
      "SELECT count(*)::int AS n FROM payment_dispatch WHERE company_id=$1 AND intent_id=$2",
      [f.companyId, first.id],
    ),
  );
  assert.equal(dispatch.n, 1);
});

test("the same key with a different amount or phone fails closed with 409", async () => {
  const f = await fixture();
  const key = "pay-" + randomUUID();
  await transaction(f.actor, (ctx) =>
    createIntent(ctx, {
      branch_id: f.branchId,
      amount: "116",
      phone: "254712345678",
      idempotency_key: key,
    }),
  );
  await assert.rejects(
    transaction(f.actor, (ctx) =>
      createIntent(ctx, {
        branch_id: f.branchId,
        amount: "1450",
        phone: "254712345678",
        idempotency_key: key,
      }),
    ),
    (err: any) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, "MPESA_IDEMPOTENCY_CONFLICT");
      return true;
    },
  );
  await assert.rejects(
    transaction(f.actor, (ctx) =>
      createIntent(ctx, {
        branch_id: f.branchId,
        amount: "116",
        phone: "254798765432",
        idempotency_key: key,
      }),
    ),
    (err: any) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, "MPESA_IDEMPOTENCY_CONFLICT");
      return true;
    },
  );
});

test("legacy callers without a key keep the old behavior", async () => {
  const f = await fixture();
  const a = await transaction(f.actor, (ctx) =>
    createIntent(ctx, {
      branch_id: f.branchId,
      amount: "116",
      phone: "254712345678",
    }),
  );
  const b = await transaction(f.actor, (ctx) =>
    createIntent(ctx, {
      branch_id: f.branchId,
      amount: "116",
      phone: "254712345678",
    }),
  );
  assert.notEqual(a.id, b.id);
});

test("keys are tenant scoped: another company may reuse the same key independently", async () => {
  const f = await fixture();
  const other = await fixture();
  const key = "pay-" + randomUUID();
  const mine = await transaction(f.actor, (ctx) =>
    createIntent(ctx, {
      branch_id: f.branchId,
      amount: "116",
      phone: "254712345678",
      idempotency_key: key,
    }),
  );
  const theirs = await transaction(other.actor, (ctx) =>
    createIntent(ctx, {
      branch_id: other.branchId,
      amount: "116",
      phone: "254712345678",
      idempotency_key: key,
    }),
  );
  assert.notEqual(mine.id, theirs.id);
});

test("concurrent identical submissions serialize: exactly one push and one winner id", async () => {
  const f = await fixture();
  const key = "pay-" + randomUUID();
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      transaction(f.actor, (ctx) =>
        createIntent(ctx, {
          branch_id: f.branchId,
          amount: "116",
          phone: "254712345678",
          idempotency_key: key,
        }),
      ),
    ),
  );
  const ids = new Set(results.map((r) => r.id));
  assert.equal(ids.size, 1, "all concurrent callers must agree on one intent");
  const rows = await transaction(f.actor, (ctx) =>
    one(
      ctx,
      "SELECT count(*)::int AS n FROM payment_intents WHERE company_id=$1 AND idempotency_key=$2",
      [f.companyId, key],
    ),
  );
  assert.equal(rows.n, 1);
});
