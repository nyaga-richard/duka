import { fixture } from "./helper.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction, one } from "../../apps/api/src/db.ts";
import { postJournal } from "@duka/accounting";
after(() => pool.end());
test("SAVEPOINT journals commit balanced; rollback removes them; older and independently committed journals never accept new lines", async () => {
  const f = await fixture(),
    date = new Date().toISOString().slice(0, 10);
  const input = () => ({
    branchId: f.branchId,
    date,
    sourceType: "manual",
    sourceId: randomUUID(),
    description: "Savepoint immutability regression",
    lines: [
      { account: "cash", debit: "12.34" },
      { account: "equity", credit: "12.34" },
    ],
  });
  let committed = "",
    abandoned = "";
  await transaction(f.actor, async (ctx) => {
    await ctx.db.query("SAVEPOINT discarded");
    abandoned = (await postJournal(ctx, input())).id;
    await ctx.db.query("ROLLBACK TO SAVEPOINT discarded");
    await ctx.db.query("RELEASE SAVEPOINT discarded");
    await ctx.db.query("SAVEPOINT accepted");
    committed = (await postJournal(ctx, input())).id;
    await ctx.db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await ctx.db.query("RELEASE SAVEPOINT accepted");
  });
  await transaction(f.actor, async (ctx) => {
    assert.equal(
      (await ctx.db.query("SELECT 1 FROM journals WHERE id=$1", [abandoned]))
        .rowCount,
      0,
    );
    const j = await one(
      ctx,
      "SELECT count(*)::int AS n,sum(debit)::text AS dr,sum(credit)::text AS cr FROM journal_lines WHERE journal_id=$1",
      [committed],
    );
    assert.deepEqual(j, { n: 2, dr: "12.34", cr: "12.34" });
  });
  for (const sql of [
    "UPDATE journal_lines SET memo='tampered' WHERE journal_id=$1",
    "DELETE FROM journal_lines WHERE journal_id=$1",
  ])
    await assert.rejects(
      () => transaction(f.actor, (ctx) => ctx.db.query(sql, [committed])),
      /immutable/,
    );
  const append = (ctx: any, id: string) =>
    ctx.db.query(
      "INSERT INTO journal_lines(company_id,journal_id,account_id,debit) SELECT $1,$2,id,1 FROM accounts WHERE company_id=$1 AND system_key='cash'",
      [f.companyId, id],
    );
  await assert.rejects(
    () => transaction(f.actor, (ctx) => append(ctx, committed)),
    /cannot append/,
  );
  // Hold an older transaction open while a different connection posts. This exercises
  // a committed xmin greater than the attacker's top-level transaction ID.
  const older = await pool.connect();
  try {
    await older.query("BEGIN");
    await older.query(
      "SELECT pg_current_xact_id(),set_config('app.company_id',$1,true)",
      [f.companyId],
    );
    const newer = await transaction(f.actor, (ctx) =>
      postJournal(ctx, input()),
    );
    await assert.rejects(
      () => append({ db: older }, newer.id),
      /cannot append/,
    );
    await older.query("ROLLBACK");
  } finally {
    await older.query("ROLLBACK");
    older.release();
  }
});
