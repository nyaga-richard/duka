import { fixture } from "./helper.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { pool, transaction } from "../../apps/api/src/db.ts";
import { postJournal, accountId, chartOfAccounts } from "@duka/accounting";
import { randomUUID } from "node:crypto";
after(() => pool.end());
test("clean migrations, safe setup, FORCE RLS and scoped foreign keys", async () => {
  const a = await fixture(),
    b = await fixture();
  const role = (
    await pool.query(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  assert.equal(role.rolsuper, false);
  assert.equal(role.rolbypassrls, false);
  await transaction(a.actor, async (ctx) => {
    assert.equal(
      (await ctx.db.query("SELECT id FROM companies")).rows.length,
      1,
    );
    assert.equal(
      (await ctx.db.query("SELECT id FROM branches WHERE id=$1", [b.branchId]))
        .rowCount,
      0,
    );
    assert.equal(
      (await ctx.db.query("SELECT id FROM accounts")).rowCount,
      chartOfAccounts.length,
    );
  });
  assert.equal((await pool.query("SELECT id FROM branches")).rowCount, 0);
  await assert.rejects(
    () =>
      transaction(a.actor, async (ctx) => {
        await ctx.db.query(
          "INSERT INTO warehouses(company_id,branch_id,name,code) VALUES($1,$2,$3,$4)",
          [a.companyId, b.branchId, "forbidden", "F"],
        );
      }),
    /foreign key/,
  );
});
test("database enforces balanced and immutable journals independently of service", async () => {
  const f = await fixture();
  const date = new Date().toISOString().slice(0, 10);
  let journalId = "";
  await transaction(f.actor, async (ctx) => {
    const j = await postJournal(ctx, {
      branchId: f.branchId,
      date,
      sourceType: "manual",
      sourceId: randomUUID(),
      description: "Opening test",
      lines: [
        { account: "cash", debit: "100.00" },
        { account: "equity", credit: "100.00" },
      ],
    });
    journalId = j.id;
  });
  await assert.rejects(
    () =>
      transaction(f.actor, (ctx) =>
        ctx.db.query("DELETE FROM journals WHERE id=$1", [journalId]),
      ),
    /immutable/,
  );
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        const a = await accountId(ctx, "cash");
        await ctx.db.query(
          "INSERT INTO journal_lines(company_id,journal_id,account_id,debit) VALUES($1,$2,$3,1)",
          [f.companyId, journalId, a],
        );
      }),
    /cannot append/,
  );
  await assert.rejects(
    () =>
      transaction(f.actor, async (ctx) => {
        await ctx.db.query(
          "INSERT INTO journals(company_id,branch_id,number,accounting_date,source_type,source_id,description,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            f.companyId,
            f.branchId,
            "BAD",
            date,
            "test",
            randomUUID(),
            "bad",
            f.userId,
          ],
        );
      }),
    /unbalanced journal/,
  );
});
