import { fixture } from "./helper.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction, one } from "../../apps/api/src/db.ts";
import { productSchema, customerSchema } from "@duka/shared";
import { createProduct } from "../../apps/api/src/services/catalog.ts";
import { configureCompany } from "../../apps/api/src/services/admin.ts";
import {
  saveOpeningBatch,
  transitionOpeningBatch,
  postOpeningBatch,
} from "../../apps/api/src/services/opening-balances.ts";
import { setupStatus } from "../../apps/api/src/services/admin.ts";
import { saveContact } from "../../apps/api/src/services/catalog.ts";
import { createCompany } from "../../scripts/setup.ts";
import { seedDemo } from "../../database/seeds/demo.ts";

process.env.LOG_LEVEL = "silent";
after(() => pool.end());

test("a freshly provisioned company reports first-run readiness per domain, ready for guidance", async () => {
  const f = await fixture();
  const status = await transaction(f.actor, (ctx) => setupStatus(ctx));
  // Structural domains arrive ready out of provisioning…
  assert.equal(status.domains.business.ready, true);
  assert.equal(status.domains.accounting.ready, true);
  assert.equal(status.domains.payments.ready, true);
  assert.equal(status.domains.inventory.ready, true);
  assert.equal(status.domains.openings.ready, true);
  // …receipts work out of the box (the default footer ships in settings -
  // customization stays available in Settings) while the first product is
  // genuinely pending.
  assert.equal(status.domains.receipt.ready, true);
  assert.equal(status.domains.catalog.ready, false);
  assert.equal(status.firstRun, true);
  assert.equal(status.completed, false);
  assert.equal(status.demo, false);
  assert.equal(status.counts.journals, 0);
  // Profile is the trusted server-side view of the business settings.
  const profile = status.domains.business.profile as any;
  assert.equal(profile.currency, "KES");
  assert.ok(profile.timezone.length >= 3);
});

test("configuring receipt text and catalog data completes the first-run checklist", async () => {
  const f = await fixture();
  await transaction(f.actor, async (ctx) => {
    const company = await one(
      ctx,
      "SELECT name,currency,timezone,settings FROM companies WHERE id=$1",
      [f.companyId],
    );
    await configureCompany(ctx, {
      name: company.name,
      currency: company.currency,
      timezone: company.timezone,
      tax_pin: "P051234567Z",
      settings: {
        ...(company.settings ?? {}),
        receiptFooter: "Asante! Karibu tena.",
        receiptWidth: 80,
        allowCredit: true,
        maxDiscountPercent: "10",
        fiscalRequired: false,
      },
    });
    const unit = await one(
        ctx,
        "SELECT id FROM units WHERE company_id=$1 LIMIT 1",
        [f.companyId],
      ),
      tax = await one(
        ctx,
        "SELECT id FROM tax_rules WHERE company_id=$1 AND code='ZERO'",
        [f.companyId],
      );
    await createProduct(
      ctx,
      productSchema.parse({
        name: "First-run tea",
        sku: "FR-" + randomUUID().slice(0, 6),
        price: "25",
        purchase_cost: "10",
        unit_id: unit.id,
        tax_rule_id: tax.id,
      }),
    );
  });
  const status = await transaction(f.actor, (ctx) => setupStatus(ctx));
  assert.equal(status.domains.receipt.ready, true);
  // The custom footer persists as the live receipt configuration.
  const persisted = await transaction(f.actor, async (ctx) =>
    one(ctx, "SELECT settings->>'receiptFooter' AS f FROM companies WHERE id=$1", [
      f.companyId,
    ]),
  );
  assert.equal(persisted.f, "Asante! Karibu tena.");
  assert.equal(status.domains.catalog.ready, true);
  assert.equal(status.domains.catalog.products, 1);
  assert.equal((status.domains.business as any).pin, true);
  // A product creation is still a first-run-safe workspace (nothing posted).
  assert.equal(status.counts.journals, 0);
  assert.equal(status.completed, true);
  assert.equal(status.firstRun, false);
});

test("opening-balance lifecycle: a half-finished cutover is flagged unsafe; posting restores a clean state", async () => {
  const f = await fixture();
  const ctxIds = await transaction(f.actor, async (ctx) => {
    await ctx.db.query(
      `UPDATE companies SET settings=settings||'{"allowSelfApproval":true}'::jsonb WHERE id=$1`,
      [f.companyId],
    );
    const dates = await one(
      ctx,
      "SELECT to_char(now() AT TIME ZONE timezone,'YYYY-MM-DD') AS today,(now() AT TIME ZONE timezone)::date-1 AS yesterday FROM companies WHERE id=$1",
      [f.companyId],
    );
    return {
      today: dates.today,
      yesterday: (
        await one(ctx, "SELECT $1::date::text AS date", [dates.yesterday])
      ).date,
    };
  });
  const draft = await transaction(f.actor, async (ctx) => {
    await saveContact(
      ctx,
      "customer",
      customerSchema.parse({ name: "First-run CRC", code: "FR-C1" }),
    );
    return saveOpeningBatch(ctx, {
      branch_id: f.branchId,
      accounting_date: ctxIds.yesterday,
      reference: "First-run legacy AR import",
      items: [
        {
          kind: "customer" as const,
          contact_code: "FR-C1",
          reference: "FR-AR-001",
          due_date: ctxIds.yesterday,
          amount: "100",
        },
      ],
    });
  });
  let status = await transaction(f.actor, (ctx) => setupStatus(ctx));
  assert.equal(status.domains.openings.ready, false, "draft must flag unsafe");
  assert.equal(status.domains.openings.drafts, 1);
  await transaction(f.actor, async (ctx) => {
    await transitionOpeningBatch(
      ctx,
      draft.id,
      "submitted",
      "First-run review of legacy balances",
    );
    await postOpeningBatch(
      ctx,
      draft.id,
      "Explicit owner approval of the first-run opening balances",
    );
  });
  status = await transaction(f.actor, (ctx) => setupStatus(ctx));
  assert.equal(status.domains.openings.ready, true);
  assert.equal(status.domains.openings.posted, 1);
  assert.equal(status.domains.openings.drafts, 0);
});

test("demo identity is machine-detectable so demo workspaces can never be confused with a real business", async () => {
  const f = await fixture();
  await transaction(f.actor, async (ctx) => {
    await ctx.db.query(
      "INSERT INTO identities(id,company_id,email,name,password_hash,status) VALUES($1,$2,$3,$4,$5,'active')",
      [
        randomUUID(),
        f.companyId,
        "sterile-" + randomUUID().slice(0, 8) + "@duka.test",
        "Synthetic demo user",
        "irrelevant-hash",
      ],
    );
  });
  const status = await transaction(f.actor, (ctx) => setupStatus(ctx));
  assert.equal(status.demo, true);
});

test("company provisioning is an idempotent seed: re-running for the same administrator is a safe refusal", async () => {
  const email = "first-run-" + randomUUID().slice(0, 8) + "@example.test";
  await createCompany({
    name: "Idempotent First Run Ltd",
    email,
    password: "FirstRunSafe-2026",
    ownerName: "First Run Owner",
  });
  const before = (
    await pool.query("SELECT count(*)::int AS n FROM companies")
  ).rows[0].n;
  await assert.rejects(
    () =>
      createCompany({
        name: "Duplicate Attempt Ltd",
        email,
        password: "FirstRunSafe-2026",
      }),
    /SETUP_IDENTITY_EXISTS/,
  );
  const after = (
    await pool.query("SELECT count(*)::int AS n FROM companies")
  ).rows[0].n;
  assert.equal(after, before, "no partial duplicate company may survive");
});

test("the demo seed itself is idempotent: a second run changes nothing", async () => {
  const demoCount = async () =>
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM identities WHERE email LIKE '%@duka.test'",
      )
    ).rows[0].n;
  await seedDemo();
  const first = await demoCount();
  await seedDemo();
  const second = await demoCount();
  assert.ok(first >= 3, "demo accounts must exist after the first seed");
  assert.equal(second, first, "a second seed run must not create duplicates");
});
