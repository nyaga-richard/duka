import crypto from "node:crypto";
import { z } from "zod";
import {
  one,
  fail,
  requirePermission,
  audit,
  transaction,
  type Actor,
  type Context,
} from "../db.ts";

// Per-company integration credentials: AES-256-GCM ciphertext at rest under
// the deployment key; the API NEVER returns stored values (presence only).
// Runtime consumption: mpesa.ts/fiscal.ts resolvers, env stays the
// deployment-wide default and the zero-config fallback.
const keyVersion = "v1";
function key() {
  const k = process.env.MFA_ENCRYPTION_KEY;
  if (k) return Buffer.from(k, "base64");
  if (process.env.NODE_ENV === "production")
    throw new Error("MFA_ENCRYPTION_KEY required to protect integration credentials");
  // Development fallback mirrors the callback-token convention.
  return crypto
    .createHash("sha256")
    .update("integration-settings:" + process.env.DATABASE_URL)
    .digest();
}
export function encryptConfig(config: any) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const plain = Buffer.from(JSON.stringify({ v: keyVersion, config }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext, iv, auth_tag: cipher.getAuthTag() };
}
export function decryptConfig(row: any): any {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), row.iv);
  decipher.setAuthTag(row.auth_tag);
  try {
    const plain = Buffer.concat([
      decipher.update(row.ciphertext),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plain.toString("utf8"));
    if (parsed.v !== keyVersion)
      throw new Error("Unknown credential key version");
    return parsed.config;
  } catch (e: any) {
    fail(
      500,
      "INTEGRATION_KEY_MISMATCH",
      "Stored integration credentials cannot be verified with this deployment key; re-enter the configuration on the Integrations page",
    );
  }
}

export const mpesaConfigSchema = z
  .object({
    consumer_key: z.string().trim().min(8).max(100),
    consumer_secret: z.string().trim().min(8).max(100),
    shortcode: z.string().regex(/^\d{5,12}$/),
    passkey: z.string().trim().min(8).max(300),
    callback_secret: z.string().trim().min(32).max(200),
    transaction_type: z
      .enum(["CustomerPayBillOnline", "CustomerBuyGoodsOnline"])
      .optional(),
    base_url: z
      .string()
      .url()
      .regex(/^https:\/\//)
      .optional(),
  })
  .strict();
export const etimsConfigSchema = z
  .object({
    adapter_url: z.string().url().regex(/^https:\/\//),
    adapter_token: z.string().trim().min(20).max(300),
  })
  .strict();

export type IntegrationMaskedStatus = {
  configured: boolean;
  enabled: boolean;
  updated_at?: string;
  updated_by?: string;
};
export async function integrationConfigStatus(
  ctx: Context,
): Promise<Record<"mpesa" | "etims", IntegrationMaskedStatus>> {
  requirePermission(ctx, "integrations.manage");
  const rows = (
    await ctx.db.query(
      "SELECT provider,enabled,updated_at,updated_by FROM integration_settings WHERE company_id=$1",
      [ctx.companyId],
    )
  ).rows;
  const out: Record<
    "mpesa" | "etims",
    IntegrationMaskedStatus
  > = {
    mpesa: { configured: false, enabled: false },
    etims: { configured: false, enabled: false },
  };
  for (const r of rows as Array<any>) {
    const provider = r.provider as "mpesa" | "etims";
    if (!out[provider]) continue;
    const updater = (
      await ctx.db.query(
        "SELECT name FROM identities WHERE company_id=$1 AND id=$2",
        [ctx.companyId, r.updated_by],
      )
    ).rows[0];
    out[provider] = {
      enabled: r.enabled,
      configured: true,
      updated_at: r.updated_at,
      updated_by: updater?.name ?? "operator",
      // never the values themselves
    };
  }
  return out;
}

export async function saveIntegrationConfig(
  ctx: Context,
  provider: "mpesa" | "etims",
  config: any,
  enabled: boolean,
) {
  requirePermission(ctx, "integrations.manage");
  let parsed: z.infer<typeof mpesaConfigSchema> | z.infer<typeof etimsConfigSchema>;
  try {
    parsed = (
      provider === "mpesa" ? mpesaConfigSchema : etimsConfigSchema
    ).parse(config ?? {});
  } catch (err: any) {
    fail(
      422,
      "VALIDATION",
      err.issues?.[0]
        ? `${provider}.${err.issues[0].path.join(".")}: ${err.issues[0].message}`
        : `Invalid ${provider} configuration`,
    );
  }
  if (provider === "mpesa" && process.env.NODE_ENV === "production") {
    const mp = parsed as z.infer<typeof mpesaConfigSchema>;
    if (mp.base_url && !/^https:\/\/api\.safaricom\.co\.ke\/?$/.test(mp.base_url))
      fail(
        422,
        "SANDBOX_FORBIDDEN",
        "Production financial posting requires the official live Daraja base URL, never sandbox",
      );
  }
  const packed = encryptConfig(parsed);
  const existing = (
    await ctx.db.query(
      "SELECT id FROM integration_settings WHERE company_id=$1 AND provider=$2 FOR UPDATE",
      [ctx.companyId, provider],
    )
  ).rows[0];
  await ctx.db.query(
    `INSERT INTO integration_settings(id,company_id,provider,enabled,ciphertext,iv,auth_tag,updated_by)
     VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(company_id,provider) DO UPDATE SET enabled=$3,ciphertext=$4,iv=$5,auth_tag=$6,updated_by=$7,updated_at=now()`,
    [
      ctx.companyId,
      provider,
      enabled,
      packed.ciphertext,
      packed.iv,
      packed.auth_tag,
      ctx.actor.id,
    ],
  );
  if (existing)
    await audit(
      ctx,
      `integrations.${provider}.reconfigure`,
      "integration_settings",
      existing.id,
    );
  return { configured: true, enabled };
}

export async function setIntegrationEnabled(
  ctx: Context,
  provider: "mpesa" | "etims",
  enabled: boolean,
) {
  requirePermission(ctx, "integrations.manage");
  const row = await one(
    ctx,
    "SELECT id,ciphertext,iv,auth_tag FROM integration_settings WHERE company_id=$1 AND provider=$2 FOR UPDATE",
    [ctx.companyId, provider],
  );
  if (enabled) decryptConfig(row); // verification before allowing enablement
  await ctx.db.query(
    "UPDATE integration_settings SET enabled=$1,updated_by=$2,updated_at=now() WHERE company_id=$3 AND id=$4",
    [enabled, ctx.actor.id, ctx.companyId, row.id],
  );
  await audit(
    ctx,
    `integrations.${provider}.${enabled ? "enable" : "disable"}`,
    "integration_settings",
    row.id,
  );
  return { enabled, configured: true };
}

// ---- Runtime resolvers (env remains deployment default/fallback) ----------
// integration_settings carries FORCE RLS, so reads must run inside the normal
// GUC-scoped transaction path; this service actor is read-only and never
// writes or audits (the armouring layer does that itself).
const serviceActor = (companyId: string): Actor =>
  ({
    id: "00000000-0000-4000-8000-000000000000",
    name: "integration-settings",
    email: "",
    company_id: companyId,
    permissions: [],
    branch_ids: [],
    warehouse_ids: [],
    approval_limit: "0",
    session_id: null,
    csrf_token: null,
  }) as unknown as Actor;
async function enabledRow(companyId: string, provider: string) {
  const row = await transaction(
    serviceActor(companyId),
    async (sub) =>
      (
        await sub.db.query(
          "SELECT ciphertext,iv,auth_tag FROM integration_settings WHERE company_id=$1 AND provider=$2 AND enabled=true",
          [companyId, provider],
        )
      ).rows[0],
    undefined,
    { readOnly: true },
  );
  return row ? decryptConfig(row) : null;
}
export async function effectiveMpesa(companyId: string) {
  const db = await enabledRow(companyId, "mpesa");
  if (db)
    return {
      mode: "daraja" as const,
      cfg: {
        base_url: db.base_url ?? "https://api.safaricom.co.ke",
        consumer_key: db.consumer_key,
        consumer_secret: db.consumer_secret,
        shortcode: db.shortcode,
        passkey: db.passkey,
        transaction_type:
          db.transaction_type ?? "CustomerPayBillOnline",
        callback_secret: db.callback_secret,
      },
      source: "company" as const,
    };
  return {
    mode: (process.env.MPESA_MODE ?? "disabled") as
      | "mock"
      | "daraja"
      | "disabled",
    cfg: null,
    source: "environment" as const,
  };
}
export type EtimsCfg = { url: string; token: string };
export async function effectiveEtims(companyId: string) {
  const db = await enabledRow(companyId, "etims");
  if (db)
    return {
      mode: "adapter" as const,
      cfg: { url: db.adapter_url, token: db.adapter_token },
      source: "company" as const,
    };
  return {
    mode: (process.env.ETIMS_MODE ?? "disabled") as "adapter" | "disabled",
    cfg: null,
    source: "environment" as const,
  };
}
