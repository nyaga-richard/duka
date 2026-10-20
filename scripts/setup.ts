import "dotenv/config";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { pool, transaction, audit, type Actor } from "../apps/api/src/db.ts";
import { permissions, defaultRoles } from "@duka/shared";
import { chartOfAccounts } from "@duka/accounting";
export async function createCompany(input: {
  name: string;
  email: string;
  password: string;
  ownerName?: string;
  currency?: string;
}) {
  if (
    input.password.length < 12 ||
    !/[a-z]/i.test(input.password) ||
    !/[0-9]/.test(input.password)
  )
    throw new Error(
      "Password must be at least 12 characters and include letters and numbers",
    );
  // Idempotent seed: re-running setup for the same administrator is a safe
  // no-op refusal — never a half-provisioned duplicate company.
  if (
    (
      await pool.query("SELECT id FROM identities WHERE email=$1", [
        input.email.toLowerCase(),
      ])
    ).rowCount
  )
    throw new Error(
      `SETUP_IDENTITY_EXISTS: an administrator with email ${input.email} already exists; nothing was changed`,
    );
  const id = randomUUID(),
    userId = randomUUID();
  const hash = await argon2.hash(input.password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 3,
    parallelism: 1,
  });
  const actor: Actor = {
    id: userId,
    company_id: id,
    name: input.ownerName ?? "Business Owner",
    email: input.email.toLowerCase(),
    permissions: [...permissions],
    branch_ids: [],
    warehouse_ids: [],
    approval_limit: "999999999999.00",
  };
  return transaction(actor, async (ctx) => {
    await ctx.db.query(
      "INSERT INTO companies(id,name,currency) VALUES($1,$2,$3)",
      [id, input.name, input.currency ?? "KES"],
    );
    await ctx.db.query(
      "INSERT INTO identities(id,company_id,email,name,password_hash) VALUES($1,$2,$3,$4,$5)",
      [userId, id, actor.email, actor.name, hash],
    );
    const b = (
      await ctx.db.query(
        "INSERT INTO branches(company_id,name,code) VALUES($1,'Main branch','HQ') RETURNING id",
        [id],
      )
    ).rows[0].id;
    const w = (
      await ctx.db.query(
        "INSERT INTO warehouses(company_id,branch_id,name,code) VALUES($1,$2,'Main store','MAIN') RETURNING id",
        [id, b],
      )
    ).rows[0].id;
    const register = (
      await ctx.db.query(
        "INSERT INTO registers(company_id,branch_id,warehouse_id,name) VALUES($1,$2,$3,'Till 01') RETURNING id",
        [id, b, w],
      )
    ).rows[0].id;
    await ctx.db.query(
      "INSERT INTO user_branches(company_id,user_id,branch_id) VALUES($1,$2,$3)",
      [id, userId, b],
    );
    await ctx.db.query(
      "INSERT INTO user_warehouses(company_id,user_id,warehouse_id) VALUES($1,$2,$3)",
      [id, userId, w],
    );
    for (const p of permissions)
      await ctx.db.query(
        "INSERT INTO permissions(code,description) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [p, p.replaceAll(".", " / ")],
      );
    for (const [name, perms] of Object.entries(defaultRoles)) {
      const role = (
        await ctx.db.query(
          "INSERT INTO roles(company_id,name,approval_limit) VALUES($1,$2,$3) RETURNING id",
          [
            id,
            name,
            name === "Business owner"
              ? "999999999999.00"
              : name === "General manager"
                ? "1000000.00"
                : name === "Branch manager"
                  ? "100000.00"
                  : name === "Accountant"
                    ? "500000.00"
                    : "0",
          ],
        )
      ).rows[0].id;
      for (const p of perms)
        await ctx.db.query(
          "INSERT INTO role_permissions(company_id,role_id,permission) VALUES($1,$2,$3)",
          [id, role, p],
        );
      if (name === "Business owner")
        await ctx.db.query(
          "INSERT INTO user_roles(company_id,user_id,role_id) VALUES($1,$2,$3)",
          [id, userId, role],
        );
    }
    for (const [code, name, type, key] of chartOfAccounts)
      await ctx.db.query(
        "INSERT INTO accounts(company_id,code,name,type,system_key) VALUES($1,$2,$3,$4,$5)",
        [id, code, name, type, key],
      );
    for (const [name, kind, key, ref] of [
      ["Cash", "cash", "cash", false],
      ["M-Pesa", "mpesa", "mpesa", true],
      ["Bank transfer", "bank", "bank", true],
      ["Card", "card", "card", true],
      ["Cheque", "cheque", "bank", true],
    ] as const)
      await ctx.db.query(
        "INSERT INTO payment_methods(company_id,name,kind,account_id,requires_reference) SELECT $1,$2,$3,id,$5 FROM accounts WHERE company_id=$1 AND system_key=$4",
        [id, name, kind, key, ref],
      );
    for (const [name, code, rate, kind] of [
      ["VAT 16%", "VAT16", "16", "standard"],
      ["Zero rated", "ZERO", "0", "zero"],
      ["Exempt", "EXEMPT", "0", "exempt"],
      ["Non-taxable", "NON", "0", "non_taxable"],
    ])
      await ctx.db.query(
        "INSERT INTO tax_rules(company_id,name,code,rate,kind,valid_from) VALUES($1,$2,$3,$4,$5,'2000-01-01')",
        [id, name, code, rate, kind],
      );
    for (const [name, symbol, fractional] of [
      ["Each", "pc", false],
      ["Kilogram", "kg", true],
      ["Litre", "L", true],
      ["Hour", "hr", true],
    ] as const)
      await ctx.db.query(
        "INSERT INTO units(company_id,name,symbol,fractional) VALUES($1,$2,$3,$4)",
        [id, name, symbol, fractional],
      );
    for (const name of [
      "Groceries",
      "Beverages",
      "Household",
      "Hardware",
      "Services",
    ])
      await ctx.db.query(
        "INSERT INTO categories(company_id,name) VALUES($1,$2)",
        [id, name],
      );
    const year = new Date().getFullYear();
    for (const y of [year - 1, year, year + 1])
      await ctx.db.query(
        "INSERT INTO accounting_periods(company_id,name,start_date,end_date) VALUES($1,$2,$3,$4)",
        [id, String(y), `${y}-01-01`, `${y}-12-31`],
      );
    await ctx.db.query(
      "INSERT INTO expense_categories(company_id,name,account_id) SELECT $1,'General operating expenses',id FROM accounts WHERE company_id=$1 AND system_key='expenses'",
      [id],
    );
    await audit(ctx, "setup", "company", id, null, {
      name: input.name,
      owner: actor.email,
    });
    return {
      companyId: id,
      userId,
      branchId: b,
      warehouseId: w,
      registerId: register,
      actor: { ...actor, branch_ids: [b], warehouse_ids: [w] },
    };
  });
}
if (/\/setup\.(ts|mjs)$/.test(process.argv[1] ?? "")) {
  const { SETUP_COMPANY, SETUP_EMAIL, SETUP_PASSWORD } = process.env;
  if (!SETUP_COMPANY || !SETUP_EMAIL || !SETUP_PASSWORD) {
    console.error(
      "Set SETUP_COMPANY, SETUP_EMAIL and SETUP_PASSWORD. Nothing was changed.",
    );
    process.exitCode = 1;
  } else
    createCompany({
      name: SETUP_COMPANY,
      email: SETUP_EMAIL,
      password: SETUP_PASSWORD,
    })
      .then((r) =>
        console.log("Created business. Record these IDs:", {
          companyId: r.companyId,
          userId: r.userId,
        }),
      )
      .catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
      })
      .finally(() => pool.end());
}
