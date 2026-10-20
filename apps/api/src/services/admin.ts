import { z } from "zod";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { permissions, D, uuid, amount, quantity, cost } from "@duka/shared";
import {
  one,
  fail,
  requirePermission,
  branchAccess,
  warehouseAccess,
  audit,
  uniqueIds,
  type Context,
  pageArgs,
} from "../db.ts";
import { validPassword } from "./auth.ts";
export const userSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: z.email().transform((v) => v.toLowerCase()),
    password: z.string().min(12).max(256),
    role_ids: z.array(uuid).min(1).max(20),
    branch_ids: z.array(uuid).min(1).max(100),
    warehouse_ids: z.array(uuid).max(100),
  })
  .strict();
export const roleSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().max(1000).optional(),
    approval_limit: amount,
    permissions: z.array(z.enum(permissions)).max(100),
  })
  .strict();
export const companySchema = z
  .object({
    name: z.string().min(2).max(160),
    currency: z.string().regex(/^[A-Z]{3}$/),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }),
    tax_pin: z.string().max(40).optional(),
    address: z.string().max(500).optional(),
    phone: z.string().max(40).optional(),
    email: z.email().or(z.literal("")).optional(),
    settings: z
      .object({
        receiptFooter: z.string().max(1000),
        returnPolicy: z.string().max(2000).optional(),
        receiptWidth: z.union([z.literal(58), z.literal(80)]),
        allowCredit: z.boolean(),
        maxDiscountPercent: cost.refine((v) => D(v).lte(100)),
        overDeliveryPercent: cost.refine((v) => D(v).lte(100)).optional(),
        allowSelfApproval: z.boolean().optional(),
        allowBackorders: z.boolean().optional(),
        fiscalRequired: z.boolean(),
        dateFormat: z.enum(["dd/MM/yyyy", "yyyy-MM-dd"]).optional(),
        logo_attachment_id: uuid.nullable().optional(),
      })
      .strict(),
  })
  .strict();
export async function configureUser(
  ctx: Context,
  input: z.infer<typeof userSchema>,
) {
  requirePermission(ctx, "users.manage");
  validPassword(input.password);
  uniqueIds(input.role_ids);
  uniqueIds(input.branch_ids);
  uniqueIds(input.warehouse_ids);
  for (const id of input.branch_ids) branchAccess(ctx, id);
  for (const id of input.warehouse_ids) {
    const w = await warehouseAccess(ctx, id);
    if (!input.branch_ids.includes(w.branch_id))
      fail(
        422,
        "USER_WAREHOUSE_BRANCH",
        "Assigned warehouse requires its branch membership",
      );
  }
  for (const id of input.role_ids) {
    const r = await one(
      ctx,
      "SELECT * FROM roles WHERE company_id=$1 AND id=$2",
      [ctx.companyId, id],
    );
    if (D(r.approval_limit).gt(ctx.actor.approval_limit))
      fail(403, "DELEGATION_LIMIT", "Cannot delegate a higher approval limit");
    const p = (
      await ctx.db.query(
        "SELECT permission FROM role_permissions WHERE company_id=$1 AND role_id=$2",
        [ctx.companyId, id],
      )
    ).rows;
    if (p.some((p) => !ctx.actor.permissions.includes(p.permission)))
      fail(
        403,
        "DELEGATION_LIMIT",
        "Cannot delegate permissions you do not hold",
      );
  }
  const hash = await argon2.hash(input.password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 3,
    parallelism: 1,
  });
  const id = randomUUID();
  await ctx.db.query(
    "INSERT INTO identities(id,company_id,name,email,password_hash) VALUES($1,$2,$3,$4,$5)",
    [id, ctx.companyId, input.name, input.email, hash],
  );
  for (const role of input.role_ids)
    await ctx.db.query(
      "INSERT INTO user_roles(company_id,user_id,role_id) VALUES($1,$2,$3)",
      [ctx.companyId, id, role],
    );
  for (const branch of input.branch_ids)
    await ctx.db.query(
      "INSERT INTO user_branches(company_id,user_id,branch_id) VALUES($1,$2,$3)",
      [ctx.companyId, id, branch],
    );
  for (const w of input.warehouse_ids)
    await ctx.db.query(
      "INSERT INTO user_warehouses(company_id,user_id,warehouse_id) VALUES($1,$2,$3)",
      [ctx.companyId, id, w],
    );
  const safe = {
    id,
    name: input.name,
    email: input.email,
    status: "active",
    role_ids: input.role_ids,
    branch_ids: input.branch_ids,
    warehouse_ids: input.warehouse_ids,
  };
  await audit(ctx, "create", "user", id, null, safe);
  return safe;
}
export async function setUserAccess(
  ctx: Context,
  id: string,
  input: {
    status: "active" | "inactive" | "suspended";
    role_ids: string[];
    branch_ids: string[];
    warehouse_ids: string[];
    reason: string;
  },
) {
  requirePermission(ctx, "users.manage");
  const u = await one(
    ctx,
    "SELECT id,name,email,status FROM identities WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  if (id === ctx.actor.id)
    fail(
      409,
      "SELF_ACCESS_CHANGE",
      "Another administrator must change your own access",
    );
  for (const b of input.branch_ids) branchAccess(ctx, b);
  for (const w of input.warehouse_ids) {
    const wh = await warehouseAccess(ctx, w);
    if (!input.branch_ids.includes(wh.branch_id))
      fail(
        422,
        "USER_WAREHOUSE_BRANCH",
        "Warehouse requires branch membership",
      );
  }
  for (const r of input.role_ids) {
    const role = await one(
      ctx,
      "SELECT * FROM roles WHERE company_id=$1 AND id=$2",
      [ctx.companyId, r],
    );
    if (D(role.approval_limit).gt(ctx.actor.approval_limit))
      fail(403, "DELEGATION_LIMIT", "Approval limit cannot exceed your own");
    const perms = (
      await ctx.db.query(
        "SELECT permission FROM role_permissions WHERE company_id=$1 AND role_id=$2",
        [ctx.companyId, r],
      )
    ).rows;
    if (perms.some((p) => !ctx.actor.permissions.includes(p.permission)))
      fail(
        403,
        "DELEGATION_LIMIT",
        "Cannot delegate permissions you do not hold",
      );
  }
  for (const table of ["user_roles", "user_branches", "user_warehouses"])
    await ctx.db.query(
      `DELETE FROM ${table} WHERE company_id=$1 AND user_id=$2`,
      [ctx.companyId, id],
    );
  for (const r of input.role_ids)
    await ctx.db.query(
      "INSERT INTO user_roles(company_id,user_id,role_id) VALUES($1,$2,$3)",
      [ctx.companyId, id, r],
    );
  for (const b of input.branch_ids)
    await ctx.db.query(
      "INSERT INTO user_branches(company_id,user_id,branch_id) VALUES($1,$2,$3)",
      [ctx.companyId, id, b],
    );
  for (const w of input.warehouse_ids)
    await ctx.db.query(
      "INSERT INTO user_warehouses(company_id,user_id,warehouse_id) VALUES($1,$2,$3)",
      [ctx.companyId, id, w],
    );
  await ctx.db.query(
    "UPDATE identities SET status=$1 WHERE company_id=$2 AND id=$3",
    [input.status, ctx.companyId, id],
  );
  await ctx.db.query(
    "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
    [id],
  );
  await audit(ctx, "access.change", "user", id, u, input, input.reason);
  return { id, status: input.status };
}
export async function configureRole(
  ctx: Context,
  input: z.infer<typeof roleSchema>,
  id?: string,
) {
  requirePermission(ctx, "users.manage");
  if (
    D(input.approval_limit).gt(ctx.actor.approval_limit) ||
    input.permissions.some((p) => !ctx.actor.permissions.includes(p))
  )
    fail(
      403,
      "DELEGATION_LIMIT",
      "Cannot delegate permissions or approval limits you do not hold",
    );
  uniqueIds(input.permissions);
  let before = null;
  const roleId = id ?? randomUUID();
  if (id) {
    before = await one(
      ctx,
      "SELECT * FROM roles WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, id],
    );
    const own = await ctx.db.query(
      "SELECT 1 FROM user_roles WHERE company_id=$1 AND user_id=$2 AND role_id=$3",
      [ctx.companyId, ctx.actor.id, id],
    );
    if (own.rowCount)
      fail(
        409,
        "SELF_ROLE_CHANGE",
        "Another administrator must change a role assigned to you",
      );
    await ctx.db.query(
      "UPDATE roles SET name=$1,description=$2,approval_limit=$3 WHERE company_id=$4 AND id=$5",
      [
        input.name,
        input.description ?? null,
        input.approval_limit,
        ctx.companyId,
        id,
      ],
    );
    await ctx.db.query(
      "DELETE FROM role_permissions WHERE company_id=$1 AND role_id=$2",
      [ctx.companyId, id],
    );
  } else
    await ctx.db.query(
      "INSERT INTO roles(id,company_id,name,description,approval_limit) VALUES($1,$2,$3,$4,$5)",
      [
        roleId,
        ctx.companyId,
        input.name,
        input.description ?? null,
        input.approval_limit,
      ],
    );
  for (const p of input.permissions)
    await ctx.db.query(
      "INSERT INTO role_permissions(company_id,role_id,permission) VALUES($1,$2,$3)",
      [ctx.companyId, roleId, p],
    );
  await audit(ctx, id ? "update" : "create", "role", roleId, before, input);
  return { id: roleId, ...input };
}
export async function configureCompany(
  ctx: Context,
  input: z.infer<typeof companySchema>,
) {
  requirePermission(ctx, "settings.manage");
  const before = await one(
    ctx,
    "SELECT * FROM companies WHERE id=$1 FOR UPDATE",
    [ctx.companyId],
  );
  if (
    before.currency.trim() !== input.currency &&
    (
      await ctx.db.query(
        "SELECT id FROM journals WHERE company_id=$1 LIMIT 1",
        [ctx.companyId],
      )
    ).rowCount
  )
    fail(
      409,
      "CURRENCY_HAS_HISTORY",
      "Company ledger currency cannot change after posting",
    );
  if (input.settings.fiscalRequired && process.env.ETIMS_MODE !== "adapter")
    fail(
      422,
      "FISCAL_UNCONFIGURED",
      "Configure a certified fiscal adapter before requiring fiscalization",
    );
  await ctx.db.query(
    "UPDATE companies SET name=$1,currency=$2,timezone=$3,tax_pin=$4,address=$5,phone=$6,email=$7,settings=$8 WHERE id=$9",
    [
      input.name,
      input.currency,
      input.timezone,
      input.tax_pin ?? null,
      input.address ?? null,
      input.phone ?? null,
      input.email ?? null,
      JSON.stringify(input.settings),
      ctx.companyId,
    ],
  );
  await audit(ctx, "update", "company", ctx.companyId, before, input);
  return { id: ctx.companyId, ...input };
}
export async function metadata(ctx: Context) {
  const company = await one(ctx, "SELECT * FROM companies WHERE id=$1", [
    ctx.companyId,
  ]);
  const queries: Record<string, [string, unknown[]]> = {
    branches: [
      "SELECT * FROM branches WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY name",
      [ctx.companyId, ctx.actor.branch_ids],
    ],
    warehouses: [
      "SELECT * FROM warehouses WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY name",
      [ctx.companyId, ctx.actor.warehouse_ids],
    ],
    registers: [
      "SELECT * FROM registers WHERE company_id=$1 AND branch_id=ANY($2::uuid[]) AND warehouse_id=ANY($3::uuid[]) AND active ORDER BY name",
      [ctx.companyId, ctx.actor.branch_ids, ctx.actor.warehouse_ids],
    ],
    units: [
      "SELECT * FROM units WHERE company_id=$1 ORDER BY name",
      [ctx.companyId],
    ],
    categories: [
      "SELECT * FROM categories WHERE company_id=$1 ORDER BY name",
      [ctx.companyId],
    ],
    tax_rules: [
      "SELECT * FROM tax_rules WHERE company_id=$1 ORDER BY code,version DESC",
      [ctx.companyId],
    ],
    payment_methods: [
      "SELECT id,name,kind,requires_reference,active FROM payment_methods WHERE company_id=$1 ORDER BY name",
      [ctx.companyId],
    ],
    price_lists: [
      "SELECT * FROM price_lists WHERE company_id=$1 ORDER BY name",
      [ctx.companyId],
    ],
  };
  const result: Record<string, any> = { company, actor: { ...ctx.actor } };
  delete result.actor.csrf_token;
  for (const [key, [sql, args]] of Object.entries(queries))
    result[key] = (await ctx.db.query(sql, args)).rows;
  if (hasAdminPermission(ctx)) {
    result.roles = (
      await ctx.db.query(
        "SELECT r.*,coalesce((SELECT jsonb_agg(permission ORDER BY permission) FROM role_permissions p WHERE p.company_id=r.company_id AND p.role_id=r.id),'[]'::jsonb) AS permissions FROM roles r WHERE r.company_id=$1 ORDER BY r.name",
        [ctx.companyId],
      )
    ).rows;
    result.permissions = permissions;
  }
  if (
    ctx.actor.permissions.some((p) =>
      ["accounting.read", "expenses.create", "shifts.manage"].includes(p),
    )
  ) {
    result.accounts = (
      await ctx.db.query(
        "SELECT * FROM accounts WHERE company_id=$1 ORDER BY code",
        [ctx.companyId],
      )
    ).rows;
    result.periods = (
      await ctx.db.query(
        "SELECT * FROM accounting_periods WHERE company_id=$1 ORDER BY start_date DESC",
        [ctx.companyId],
      )
    ).rows;
    result.expense_categories = (
      await ctx.db.query(
        "SELECT * FROM expense_categories WHERE company_id=$1 ORDER BY name",
        [ctx.companyId],
      )
    ).rows;
  }
  return result;
}
const hasAdminPermission = (ctx: Context) =>
  ctx.actor.permissions.includes("users.manage");
export async function listUsers(ctx: Context, q: any) {
  requirePermission(ctx, "users.manage");
  const { page, limit, offset } = pageArgs(q);
  const r = await ctx.db.query(
    `SELECT u.id,u.name,u.email,u.status,u.mfa_enabled,u.created_at,coalesce((SELECT jsonb_agg(r.name) FROM user_roles ur JOIN roles r ON r.company_id=ur.company_id AND r.id=ur.role_id WHERE ur.company_id=u.company_id AND ur.user_id=u.id),'[]') AS roles,coalesce((SELECT jsonb_agg(ur.role_id) FROM user_roles ur WHERE ur.company_id=u.company_id AND ur.user_id=u.id),'[]') AS role_ids,coalesce((SELECT jsonb_agg(b.branch_id) FROM user_branches b WHERE b.company_id=u.company_id AND b.user_id=u.id),'[]') AS branch_ids,coalesce((SELECT jsonb_agg(w.warehouse_id) FROM user_warehouses w WHERE w.company_id=u.company_id AND w.user_id=u.id),'[]') AS warehouse_ids,count(*) OVER()::int AS _count FROM identities u WHERE company_id=$1 AND (name ILIKE $2 OR email ILIKE $2) ORDER BY name LIMIT $3 OFFSET $4`,
    [ctx.companyId, `%${String(q.q ?? "").slice(0, 120)}%`, limit, offset],
  );
  return {
    items: r.rows.map(({ _count, ...r }) => r),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
  };
}
// First-run readiness for the administrator setup flow. Read-only: it never
// mutates business data, and it reports the trusted server-side state a fresh
// installation must reach across the seven requested setup domains. Demo data
// stays isolated and detectable: any identity on the reserved @duka.test
// domain flags the whole company as demo regardless of how it was seeded.
export async function setupStatus(ctx: Context) {
  requirePermission(ctx, "settings.manage");
  const company = await one(
      ctx,
      "SELECT id,name,currency,timezone,tax_pin,address,phone,email,settings FROM companies WHERE id=$1",
      [ctx.companyId],
    ),
    demoIdentity = await one(
      ctx,
      "SELECT EXISTS(SELECT 1 FROM identities WHERE company_id=$1 AND email LIKE '%@duka.test') AS exists",
      [ctx.companyId],
    );
  const counts = await one(
    ctx,
    `SELECT
      (SELECT count(*)::int FROM accounts WHERE company_id=$1) AS accounts,
      (SELECT count(*)::int FROM accounting_periods WHERE company_id=$1) AS periods,
      (SELECT count(*)::int FROM branches WHERE company_id=$1) AS branches,
      (SELECT count(*)::int FROM warehouses WHERE company_id=$1) AS warehouses,
      (SELECT count(*)::int FROM registers WHERE company_id=$1) AS registers,
      (SELECT count(*)::int FROM payment_methods WHERE company_id=$1) AS methods,
      (SELECT count(*)::int FROM categories WHERE company_id=$1) AS categories,
      (SELECT count(*)::int FROM products WHERE company_id=$1) AS products,
      (SELECT count(*)::int FROM customers WHERE company_id=$1) AS customers,
      (SELECT count(*)::int FROM suppliers WHERE company_id=$1) AS suppliers,
      (SELECT count(*)::int FROM stock_documents WHERE company_id=$1) AS stockdocuments,
      (SELECT count(*)::int FROM sales WHERE company_id=$1) AS sales,
      (SELECT count(*)::int FROM journals WHERE company_id=$1) AS journals,
      (SELECT count(*)::int FROM opening_batches WHERE company_id=$1 AND status='draft') AS openingdrafts,
      (SELECT count(*)::int FROM opening_batches WHERE company_id=$1 AND status='submitted') AS openingsubmitted,
      (SELECT count(*)::int FROM opening_batches WHERE company_id=$1 AND status='posted') AS openingposted`,
    [ctx.companyId],
  );
  const settings = (company.settings ?? {}) as Record<string, any>;
  const domains = {
    business: {
      // Provisioning always installs one legal profile; the KRA PIN is the
      // field a first-run operator must double check before fiscal receipts.
      ready: true,
      pin: Boolean(company.tax_pin),
      profile: {
        name: company.name,
        currency: company.currency,
        timezone: company.timezone,
        tax_pin: company.tax_pin ?? null,
        address: company.address ?? null,
        phone: company.phone ?? null,
        email: company.email ?? null,
      },
    },
    receipt: {
      ready: Boolean(String(settings.receiptFooter ?? "").trim()),
      footer: Boolean(String(settings.receiptFooter ?? "").trim()),
      width: settings.receiptWidth ?? 80,
      logo: settings.logo_attachment_id ?? null,
      policy: Boolean(settings.returnPolicy),
    },
    accounting: {
      ready: counts.accounts > 0 && counts.periods > 0,
      accounts: counts.accounts,
      periods: counts.periods,
    },
    payments: {
      // Seeded tenders are wired to real accounts at provisioning; readiness
      // is therefore structural, and additional tills are additive only.
      ready: counts.methods >= 1,
      methods: counts.methods,
    },
    catalog: {
      ready: counts.products >= 1,
      categories: counts.categories,
      products: counts.products,
    },
    inventory: {
      ready: counts.warehouses >= 1 && counts.registers >= 1,
      warehouses: counts.warehouses,
      registers: counts.registers,
      documents: counts.stockdocuments,
    },
    openings: {
      // A half-finished cutover (draft or submitted but unposted) is the only
      // unsafe state; no legacy balances is a perfectly valid steady state.
      ready: counts.openingdrafts === 0 && counts.openingsubmitted === 0,
      drafts: counts.openingdrafts,
      submitted: counts.openingsubmitted,
      posted: counts.openingposted,
      contacts: { customers: counts.customers, suppliers: counts.suppliers },
    },
  } as const;
  return {
    domains,
    completed: Object.values(domains).every((d: any) => d.ready),
    // A genuinely fresh workspace: nothing sold, nothing posted anywhere.
    firstRun: counts.products === 0 && counts.journals === 0,
    counts: {
      sales: counts.sales,
      journals: counts.journals,
    },
    demo: demoIdentity.exists === true,
  };
}
