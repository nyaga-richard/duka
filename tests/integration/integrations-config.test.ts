import { fixture } from "./helper.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { pool, transaction, one, digest } from "../../apps/api/src/db.ts";
import { supplierSchema } from "@duka/shared";
import { saveContact } from "../../apps/api/src/services/catalog.ts";
import {
  saveIntegrationConfig,
  setIntegrationEnabled,
  integrationConfigStatus,
  effectiveMpesa,
  effectiveEtims,
} from "../../apps/api/src/services/integrations-config.ts";
import {
  createIntent,
  callbackToken,
} from "../../apps/api/src/integrations/mpesa.ts";

after(() => pool.end());

const MPESA_CFG = {
  consumer_key: "ck-9f2b-sample-key",
  consumer_secret: "cs-0f71-sample-secret-length-ok",
  shortcode: "600000",
  passkey: "pk-44c-complaint-passkey-sample-here",
  callback_secret: "company-callback-secret-0123456789abcdef",
  transaction_type: "CustomerPayBillOnline",
};

test("supplier creation accepts and persists credit limit and discount terms", async () => {
  const f = await fixture();
  const supplier = await transaction(f.actor, (ctx) =>
    saveContact(
      ctx,
      "supplier",
      supplierSchema.parse({
        name: "Terms supplier",
        code: "TERMS1",
        credit_limit: "150000.50",
        discount_percent: "7.5",
      }),
    ),
  );
  const row = await transaction(f.actor, (ctx) =>
    one(ctx, "SELECT * FROM suppliers WHERE id=$1", [supplier.id]),
  );
  assert.equal(Number(row.credit_limit), 150000.5);
  assert.equal(Number(row.discount_percent), 7.5);
});

test("integration secrets encrypt at rest, status masks all values, tenant isolation holds", async () => {
  const f = await fixture();
  const f2 = await fixture();
  // toggle with nothing configured must fail
  await assert.rejects(
    transaction(f.actor, (ctx) => setIntegrationEnabled(ctx, "mpesa", true)),
    /not configured|record not found/i,
  );
  await transaction(f.actor, (ctx) =>
    saveIntegrationConfig(ctx, "mpesa", MPESA_CFG, true),
  );
  await transaction(f.actor, (ctx) =>
    saveIntegrationConfig(
      ctx,
      "etims",
      { adapter_url: "https://gateway.example.co.ke", adapter_token: "t".repeat(24) },
      false,
    ),
  );
  // at-rest ciphertext contains none of the values; FORCE RLS must also hide
  // the table from any connection without tenant GUC (raw pool sees zero rows)
  const rawProbe = await pool.query(
    "SELECT count(*)::int AS n FROM integration_settings",
  );
  assert.equal(rawProbe.rows[0].n, 0);
  const stored = await transaction(f.actor, async (ctx) =>
    (
      await ctx.db.query(
        "SELECT ciphertext,iv,auth_tag FROM integration_settings WHERE company_id=$1 ORDER BY provider",
        [f.companyId],
      )
    ).rows,
  );
  assert.equal(stored.length, 2);
  const bundle = stored.map((r) => JSON.stringify(r)).join("");
  for (const secret of [
    MPESA_CFG.consumer_key,
    MPESA_CFG.consumer_secret,
    MPESA_CFG.passkey,
    MPESA_CFG.callback_secret,
    "t".repeat(24),
  ])
    assert.ok(!bundle.includes(secret), `secret leaked at rest: ${secret.slice(0, 6)}`);
  // masked status: configured/enabled/actor name — never values
  const status = await transaction(f.actor, (ctx) => integrationConfigStatus(ctx));
  assert.equal(status.mpesa.configured, true);
  assert.equal(status.mpesa.enabled, true);
  assert.equal(status.etims.configured, true);
  assert.equal(status.etims.enabled, false);
  assert.ok((status.mpesa.updated_by ?? "").length > 0);
  assert.ok(!JSON.stringify(status).includes("600000"));
  assert.ok(!JSON.stringify(status).includes(MPESA_CFG.consumer_secret));
  // cross-tenant: second company sees nothing of the first
  const foreign = await effectiveMpesa(f2.companyId);
  assert.equal(foreign.cfg, null);
  assert.equal(foreign.mode, "mock"); // deployment default: TEST env is mock
  const foreignStatus = await transaction(f2.actor, (ctx) =>
    integrationConfigStatus(ctx),
  );
  assert.equal(foreignStatus.mpesa.configured, false);
});

test("configuration validation rejects malformed credentials with 422", async () => {
  const f = await fixture();
  await assert.rejects(
    transaction(f.actor, (ctx) =>
      saveIntegrationConfig(ctx, "mpesa", { ...MPESA_CFG, shortcode: "12a4" }, true),
    ),
    (err: any) => err.status === 422,
  );
  await assert.rejects(
    transaction(f.actor, (ctx) =>
      saveIntegrationConfig(
        ctx,
        "mpesa",
        { ...MPESA_CFG, base_url: "http://sandbox.safaricom.co.ke" },
        true,
      ),
    ),
    (err: any) => err.status === 422,
  );
  await assert.rejects(
    transaction(f.actor, (ctx) =>
      saveIntegrationConfig(
        ctx,
        "etims",
        { adapter_url: "http://insecure.example.co.ke", adapter_token: "t".repeat(24) },
        true,
      ),
    ),
    (err: any) => err.status === 422,
  );
  await assert.rejects(
    transaction(f.actor, (ctx) =>
      saveIntegrationConfig(
        ctx,
        "etims",
        { adapter_url: "https://gateway.example.co.ke", adapter_token: "short" },
        true,
      ),
    ),
    (err: any) => err.status === 422,
  );
});

test("company-enabled M-Pesa config is honoured per-intent and signs callbacks with its own secret; disable falls back", async () => {
  const f = await fixture();
  const origSecret = process.env.MPESA_CALLBACK_SECRET;
  process.env.MPESA_CALLBACK_SECRET = "env-level-callback-secret-do-not-use";
  try {
    await transaction(f.actor, (ctx) =>
      saveIntegrationConfig(ctx, "mpesa", MPESA_CFG, true),
    );
    const eff = await effectiveMpesa(f.companyId);
    assert.equal(eff.mode, "daraja");
    assert.equal((eff.cfg as any).shortcode, "600000");
    const intent = await transaction(f.actor, (ctx) =>
      createIntent(ctx, {
        branch_id: f.branchId,
        amount: "100",
        phone: "254712345678",
      }),
    );
    assert.equal(intent.provider, "daraja");
    const row = await transaction(f.actor, (ctx) =>
      one(ctx, "SELECT callback_token_hash FROM payment_intents WHERE id=$1", [
        intent.id,
      ]),
    );
    // token must have been created with the company secret, not the env secret
    assert.equal(row.callback_token_hash, digest(callbackToken(intent.id, MPESA_CFG.callback_secret)));
    assert.notEqual(
      row.callback_token_hash,
      digest(callbackToken(intent.id, "env-level-callback-secret-do-not-use")),
    );
    // disabling blocks further daraja initiation (falls back to deployment default mock)
    await transaction(f.actor, (ctx) => setIntegrationEnabled(ctx, "mpesa", false));
    const disabled = await transaction(f.actor, (ctx) =>
      createIntent(ctx, {
        branch_id: f.branchId,
        amount: "100",
        phone: "254712345678",
      }),
    );
    assert.equal(disabled.provider, "mock");
    const effAfter = await effectiveMpesa(f.companyId);
    assert.equal(effAfter.mode, "mock");
    assert.equal(effAfter.cfg, null);
  } finally {
    if (origSecret === undefined) delete process.env.MPESA_CALLBACK_SECRET;
    else process.env.MPESA_CALLBACK_SECRET = origSecret;
  }
});

test("eTIMS gateway config feeds adapter construction only while enabled", async () => {
  const f = await fixture();
  await transaction(f.actor, (ctx) =>
    saveIntegrationConfig(
      ctx,
      "etims",
      { adapter_url: "https://gateway.example.co.ke", adapter_token: "t".repeat(24) },
      true,
    ),
  );
  const eff = await effectiveEtims(f.companyId);
  assert.equal(eff.mode, "adapter");
  assert.equal((eff.cfg as any).url, "https://gateway.example.co.ke");
  await transaction(f.actor, (ctx) => setIntegrationEnabled(ctx, "etims", false));
  const after0 = await effectiveEtims(f.companyId);
  assert.equal(after0.mode, "disabled");
  assert.equal(after0.cfg, null);
});

test("rotating the encryption key fails closed with INTEGRATION_KEY_MISMATCH, never returns garbled credentials", async () => {
  const f = await fixture();
  const origKey = process.env.MFA_ENCRYPTION_KEY;
  await transaction(f.actor, (ctx) =>
    saveIntegrationConfig(ctx, "mpesa", MPESA_CFG, true),
  );
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    await assert.rejects(effectiveMpesa(f.companyId), (err: any) => {
      assert.equal(err.code, "INTEGRATION_KEY_MISMATCH");
      return true;
    });
    await assert.rejects(
      transaction(f.actor, (ctx) => setIntegrationEnabled(ctx, "mpesa", true)),
      (err: any) => {
        assert.equal(err.code, "INTEGRATION_KEY_MISMATCH");
        return true;
      },
    );
    // masked status still works without decrypting (no outage of the page itself)
    const status = await transaction(f.actor, (ctx) => integrationConfigStatus(ctx));
    assert.equal(status.mpesa.configured, true);
    // re-saving fresh configuration under the new key heals the deployment
    await transaction(f.actor, (ctx) =>
      saveIntegrationConfig(ctx, "mpesa", MPESA_CFG, true),
    );
    const healed = await effectiveMpesa(f.companyId);
    assert.equal(healed.mode, "daraja");
  } finally {
    if (origKey === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = origKey;
  }
});
