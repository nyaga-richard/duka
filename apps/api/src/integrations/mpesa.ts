import { D, money } from "@duka/shared";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { effectiveMpesa } from "../services/integrations-config.ts";
import {
  pool,
  transaction,
  one,
  fail,
  audit,
  digest,
  requirePermission,
  branchAccess,
  type Context,
  type Actor,
  idempotent,
} from "../db.ts";
export interface MpesaProvider {
  initiate(input: {
    amount: string;
    phone: string;
    reference: string;
    callbackUrl: string;
  }): Promise<{ checkoutId: string }>;
  query(checkoutId: string): Promise<{
    status: "pending" | "successful" | "failed" | "cancelled" | "timed_out";
    receipt?: string;
    error?: string;
  }>;
}
export class MockMpesa implements MpesaProvider {
  async initiate(input: { amount: string; phone: string }) {
    const checkoutId = "mock_" + randomUUID();
    await pool.query(
      "INSERT INTO mock_provider_transactions(checkout_id,amount,phone) VALUES($1,$2,$3)",
      [checkoutId, input.amount, input.phone],
    );
    return { checkoutId };
  }
  async query(id: string) {
    const r = (
      await pool.query(
        "SELECT * FROM mock_provider_transactions WHERE checkout_id=$1",
        [id],
      )
    ).rows[0];
    return r
      ? { status: r.status, receipt: r.receipt ?? undefined }
      : { status: "pending" as const, error: "Unknown mock request" };
  }
}
export type MpesaRuntimeCfg = {
  base_url: string;
  consumer_key: string;
  consumer_secret: string;
  shortcode: string;
  passkey: string;
  transaction_type: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
  callback_secret: string;
};
// Company-scoped config (from encrypted integration_settings) overrides the
// deployment-wide environment; validation already happened at save time.
export class DarajaMpesa implements MpesaProvider {
  private token = "";
  private expiry = 0;
  constructor(private cfg: MpesaRuntimeCfg | null = null) {}
  private base() {
    const url =
      this.cfg?.base_url ??
      process.env.MPESA_BASE_URL ??
      "https://sandbox.safaricom.co.ke";
    if (
      ![
        "https://sandbox.safaricom.co.ke",
        "https://api.safaricom.co.ke",
      ].includes(url)
    )
      throw new Error("Unsupported M-Pesa provider URL");
    return url;
  }
  private async request(path: string, body?: unknown) {
    if (!this.token || this.expiry < Date.now()) {
      const key = this.cfg?.consumer_key ?? process.env.MPESA_CONSUMER_KEY,
        secret =
          this.cfg?.consumer_secret ?? process.env.MPESA_CONSUMER_SECRET;
      if (!key || !secret) throw new Error("M-Pesa OAuth credentials missing");
      const response = await fetch(
        this.base() + "/oauth/v1/generate?grant_type=client_credentials",
        {
          headers: {
            Authorization:
              "Basic " + Buffer.from(key + ":" + secret).toString("base64"),
          },
          signal: AbortSignal.timeout(10000),
        },
      );
      const data: any = await response.json();
      if (!response.ok || !data.access_token)
        throw new Error("M-Pesa OAuth request failed");
      this.token = data.access_token;
      this.expiry =
        Date.now() + Math.max(30, Number(data.expires_in ?? 3599) - 60) * 1000;
    }
    const response = await fetch(this.base() + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data: any = await response.json();
    if (!response.ok)
      throw new Error(`M-Pesa provider request failed (${response.status})`);
    return data;
  }
  private credentials() {
    const shortcode = this.cfg?.shortcode ?? process.env.MPESA_SHORTCODE,
      passkey = this.cfg?.passkey ?? process.env.MPESA_PASSKEY;
    if (!shortcode || !passkey)
      throw new Error("M-Pesa shortcode/passkey missing");
    const timestamp = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Africa/Nairobi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .format(new Date())
      .replace(/[^0-9]/g, "");
    return {
      BusinessShortCode: shortcode,
      Password: Buffer.from(shortcode + passkey + timestamp).toString("base64"),
      Timestamp: timestamp,
    };
  }
  async initiate(input: {
    amount: string;
    phone: string;
    reference: string;
    callbackUrl: string;
  }) {
    if (!D(input.amount).isInteger())
      throw new Error("STK Push requires whole KES amounts");
    const credentials = this.credentials();
    const r = await this.request("/mpesa/stkpush/v1/processrequest", {
      ...credentials,
      TransactionType:
        this.cfg?.transaction_type ??
        process.env.MPESA_TRANSACTION_TYPE ??
        "CustomerPayBillOnline",
      Amount: input.amount,
      PartyA: input.phone,
      PartyB: credentials.BusinessShortCode,
      PhoneNumber: input.phone,
      CallBackURL: input.callbackUrl,
      AccountReference: input.reference.slice(0, 12),
      TransactionDesc: "POS payment",
    });
    if (String(r.ResponseCode) !== "0" || !r.CheckoutRequestID)
      throw new Error("M-Pesa did not accept the STK request");
    return { checkoutId: String(r.CheckoutRequestID) };
  }
  async query(checkoutId: string) {
    const r = await this.request("/mpesa/stkpushquery/v1/query", {
      ...this.credentials(),
      CheckoutRequestID: checkoutId,
    });
    const code = String(r.ResultCode ?? "");
    return {
      status:
        code === "0"
          ? ("successful" as const)
          : code === "1032"
            ? ("cancelled" as const)
            : ["1037", "1025"].includes(code)
              ? ("timed_out" as const)
              : code
                ? ("failed" as const)
                : ("pending" as const),
      error: r.ResultDesc ?? r.errorMessage,
    };
  }
}
const mock = new MockMpesa(),
  daraja = new DarajaMpesa();
export const provider = (
  mode = process.env.MPESA_MODE,
  cfg: MpesaRuntimeCfg | null = null,
): MpesaProvider => {
  if (mode === "daraja") return cfg ? new DarajaMpesa(cfg) : daraja;
  if (mode === "mock" && process.env.NODE_ENV !== "production") return mock;
  throw new Error("The recorded payment provider is disabled or unavailable");
};
export function callbackToken(id: string, configuredSecret?: string) {
  const secret =
    configuredSecret ??
    process.env.MPESA_CALLBACK_SECRET ??
    (process.env.NODE_ENV !== "production"
      ? process.env.DATABASE_URL
      : undefined);
  if (!secret) throw new Error("MPESA_CALLBACK_SECRET missing");
  return createHmac("sha256", secret).update(id).digest("base64url");
}
export async function createIntent(
  ctx: Context,
  input: {
    branch_id: string;
    amount: string;
    phone: string;
    idempotency_key?: string;
  },
) {
  requirePermission(ctx, "sales.create");
  const eff = await effectiveMpesa(ctx.companyId);
  const mode = eff.mode;
  if (
    !["mock", "daraja"].includes(mode) ||
    (mode === "mock" && process.env.NODE_ENV === "production")
  )
    fail(
      503,
      "MPESA_DISABLED",
      "M-Pesa initiation is disabled until merchant onboarding is configured",
    );
  branchAccess(ctx, input.branch_id);
  if (input.idempotency_key) {
    const prior = (
      await ctx.db.query(
        "SELECT id,branch_id,amount,phone,provider,status FROM payment_intents WHERE company_id=$1 AND idempotency_key=$2 FOR UPDATE",
        [ctx.companyId, input.idempotency_key],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.branch_id !== input.branch_id ||
        !D(prior.amount.toString()).eq(D(input.amount)) ||
        prior.phone !== input.phone
      )
        fail(
          409,
          "MPESA_IDEMPOTENCY_CONFLICT",
          "This idempotency key was already used for a different M-Pesa request. To change the amount or phone, start a fresh M-Pesa tender.",
        );
      await audit(ctx, "deduplicate", "payment_intent", prior.id, null, {
        idempotency_key: input.idempotency_key,
      });
      return {
        id: prior.id,
        status: prior.status,
        provider: prior.provider,
        deduplicated: true,
      };
    }
  }
  if (!D(input.amount).isInteger() || D(input.amount).lte(0))
    fail(
      422,
      "MPESA_AMOUNT",
      "M-Pesa STK amount must be a positive whole number of KES",
    );
  const c = await one(ctx, "SELECT currency FROM companies WHERE id=$1", [
    ctx.companyId,
  ]);
  if (c.currency.trim() !== "KES")
    fail(422, "MPESA_CURRENCY", "M-Pesa provider supports KES only");
  const id = randomUUID(),
    token = callbackToken(id, eff.cfg?.callback_secret);
  if (input.idempotency_key) await ctx.db.query("SAVEPOINT idem_insert");
  try {
    await ctx.db.query(
      "INSERT INTO payment_intents(id,company_id,branch_id,created_by,amount,phone,provider,callback_token_hash,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        ctx.companyId,
        input.branch_id,
        ctx.actor.id,
        input.amount,
        input.phone,
        mode,
        digest(token),
        input.idempotency_key ?? null,
      ],
    );
  } catch (e: any) {
    // Concurrent identical submissions: the unique index serialises them, the
    // loser re-reads the winner's row and returns it instead of pushing twice.
    if (input.idempotency_key && e.code === "23505") {
      await ctx.db.query("ROLLBACK TO SAVEPOINT idem_insert");
      const winner = (
        await ctx.db.query(
          "SELECT id,status,provider FROM payment_intents WHERE company_id=$1 AND idempotency_key=$2",
          [ctx.companyId, input.idempotency_key],
        )
      ).rows[0];
      if (winner)
        return {
          id: winner.id,
          status: winner.status,
          provider: winner.provider,
          deduplicated: true,
        };
    }
    throw e;
  }
  await ctx.db.query(
    "INSERT INTO payment_dispatch(intent_id,company_id,actor_id,token_hash) VALUES($1,$2,$3,$4)",
    [id, ctx.companyId, ctx.actor.id, digest(token)],
  );
  await audit(ctx, "initiate", "payment_intent", id, null, {
    amount: input.amount,
    provider: mode,
    phone: "***" + input.phone.slice(-4),
  });
  return { id, status: "pending", provider: mode };
}
export async function dispatchIntent(actor: Actor, id: string) {
  const claim = await pool.query(
    "UPDATE payment_dispatch SET claimed_at=now() WHERE intent_id=$1 AND company_id=$2 AND claimed_at IS NULL RETURNING *",
    [id, actor.company_id],
  );
  if (!claim.rowCount) return;
  const input = await transaction(actor, (ctx) =>
    one(ctx, "SELECT * FROM payment_intents WHERE company_id=$1 AND id=$2", [
      actor.company_id,
      id,
    ]),
  );
  try {
    const base =
      process.env.MPESA_CALLBACK_BASE_URL ??
      process.env.WEB_ORIGIN ??
      "http://localhost:3000";
    if (input.provider === "daraja" && !base.startsWith("https://"))
      throw new Error("M-Pesa callback requires HTTPS");
    const effDispatch =
      input.provider === "daraja"
        ? await effectiveMpesa(actor.company_id)
        : {
            mode: input.provider,
            cfg: null as any,
          };
    if (input.provider === "daraja" && effDispatch.mode !== "daraja")
      throw new Error(
        "The company M-Pesa integration was disabled or re-keyed after this intent was created",
      );
    const result = await provider(input.provider, effDispatch.cfg).initiate({
      amount: input.amount,
      phone: input.phone,
      reference: id.replaceAll("-", "").slice(0, 12),
      callbackUrl: `${base}/api/v1/integrations/mpesa/callback/${callbackToken(id, (effDispatch.cfg as MpesaRuntimeCfg | null)?.callback_secret)}`,
    });
    await transaction(actor, async (ctx) => {
      await ctx.db.query(
        "UPDATE payment_intents SET checkout_id=$1,updated_at=now() WHERE company_id=$2 AND id=$3",
        [result.checkoutId, ctx.companyId, id],
      );
      await ctx.db.query(
        "UPDATE payment_dispatch SET checkout_id=$1 WHERE intent_id=$2",
        [result.checkoutId, id],
      );
    });
  } catch (e: any) {
    await transaction(actor, (ctx) =>
      ctx.db.query(
        "UPDATE payment_intents SET last_error=$1,updated_at=now() WHERE company_id=$2 AND id=$3",
        [
          `${e.message}. Request outcome may be unknown; reconcile before creating another intent.`,
          ctx.companyId,
          id,
        ],
      ),
    );
  }
}
export async function receiveCallback(token: string, payload: any) {
  const map = (
    await pool.query("SELECT * FROM payment_dispatch WHERE token_hash=$1", [
      digest(token),
    ])
  ).rows[0];
  if (!map) fail(403, "INVALID_CALLBACK", "Callback rejected");
  const c = payload?.Body?.stkCallback;
  if (
    !c ||
    typeof c.CheckoutRequestID !== "string" ||
    !Number.isInteger(c.ResultCode)
  )
    fail(422, "INVALID_CALLBACK", "Malformed provider callback");
  if (map.checkout_id && map.checkout_id !== c.CheckoutRequestID)
    fail(
      422,
      "CALLBACK_MISMATCH",
      "Checkout identifier does not match this callback token",
    );
  const items = c.CallbackMetadata?.Item ?? [];
  const value = (name: string) =>
    items.find((x: any) => x.Name === name)?.Value;
  const safe = {
    intent_id: map.intent_id,
    result_code: c.ResultCode,
    amount: value("Amount") == null ? null : String(value("Amount")),
    receipt:
      value("MpesaReceiptNumber") == null
        ? null
        : String(value("MpesaReceiptNumber")),
    phone: value("PhoneNumber") == null ? null : String(value("PhoneNumber")),
  };
  const key = digest(`${c.CheckoutRequestID}:${JSON.stringify(safe)}`);
  await pool.query(
    "INSERT INTO provider_events(provider,event_key,checkout_id,payload) VALUES('mpesa',$1,$2,$3) ON CONFLICT(event_key) DO NOTHING",
    [key, c.CheckoutRequestID, JSON.stringify(safe)],
  );
  return { accepted: true };
}
export async function integrationActor(
  companyId: string,
  userId: string,
): Promise<Actor> {
  const user = (
    await pool.query(
      "SELECT id,name,email FROM identities WHERE company_id=$1 AND id=$2",
      [companyId, userId],
    )
  ).rows[0];
  if (!user) throw new Error("Integration actor no longer exists");
  const actor: Actor = {
    ...user,
    company_id: companyId,
    permissions: ["integrations.manage", "sales.read"],
    branch_ids: [],
    warehouse_ids: [],
    approval_limit: "0",
  };
  return transaction(actor, async (ctx) => {
    actor.branch_ids = (
      await ctx.db.query(
        "SELECT branch_id FROM user_branches WHERE company_id=$1 AND user_id=$2",
        [companyId, userId],
      )
    ).rows.map((r) => r.branch_id);
    actor.warehouse_ids = (
      await ctx.db.query(
        "SELECT warehouse_id FROM user_warehouses WHERE company_id=$1 AND user_id=$2",
        [companyId, userId],
      )
    ).rows.map((r) => r.warehouse_id);
    return actor;
  });
}
export async function processMpesaEvent(
  eventId: string,
  customProvider?: MpesaProvider,
) {
  const event = (
    await pool.query("SELECT * FROM provider_events WHERE id=$1", [eventId])
  ).rows[0];
  if (!event || event.status === "processed") return { duplicate: true };
  const map = (
    await pool.query("SELECT * FROM payment_dispatch WHERE intent_id=$1", [
      event.payload.intent_id,
    ])
  ).rows[0];
  if (!map || !map.checkout_id)
    throw new Error(
      "Awaiting initiation response before callback verification",
    );
  const actor = await integrationActor(map.company_id, map.actor_id);
  const providerName = await transaction(actor, (ctx) =>
    one(
      ctx,
      "SELECT provider FROM payment_intents WHERE company_id=$1 AND id=$2",
      [ctx.companyId, map.intent_id],
    ),
  );
  const effEvent =
    !customProvider && providerName.provider === "daraja"
      ? await effectiveMpesa(actor.company_id)
      : null;
  const query = await (
    customProvider ?? provider(providerName.provider, effEvent?.cfg ?? null)
  ).query(
    map.checkout_id,
  );
  return transaction(actor, async (ctx) => {
    const intent = await one(
      ctx,
      "SELECT * FROM payment_intents WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, map.intent_id],
    );
    if (intent.status === "successful") {
      await ctx.db.query(
        "UPDATE provider_events SET status='processed' WHERE id=$1",
        [event.id],
      );
      return { duplicate: true };
    }
    const p = event.payload;
    if (event.checkout_id !== intent.checkout_id)
      fail(409, "CALLBACK_MISMATCH", "Callback checkout mismatch");
    ctx.branchId = intent.branch_id;
    if (query.status === "successful") {
      if (
        p.result_code !== 0 ||
        !p.receipt ||
        !p.amount ||
        !D(p.amount).eq(intent.amount) ||
        p.phone !== intent.phone ||
        (query.receipt !== undefined && query.receipt !== p.receipt)
      )
        fail(
          422,
          "CALLBACK_MISMATCH",
          "Successful provider query requires matching amount, phone and receipt metadata",
        );
      await ctx.db.query(
        "UPDATE payment_intents SET status='successful',receipt_number=$1,last_error=NULL,updated_at=now() WHERE company_id=$2 AND id=$3",
        [p.receipt, ctx.companyId, intent.id],
      );
      await audit(
        ctx,
        "provider_confirmed",
        "payment_intent",
        intent.id,
        null,
        {
          status: "successful",
          receipt: p.receipt,
          confirmation: "query + token-bound callback metadata",
        },
      );
    } else if (query.status !== "pending") {
      await ctx.db.query(
        "UPDATE payment_intents SET status=$1,last_error=$2,updated_at=now() WHERE company_id=$3 AND id=$4",
        [query.status, query.error ?? null, ctx.companyId, intent.id],
      );
    } else throw new Error("Provider still reports pending");
    await ctx.db.query(
      "UPDATE provider_events SET status='processed',last_error=NULL WHERE id=$1",
      [event.id],
    );
    return { status: query.status };
  });
}
export async function mockComplete(
  ctx: Context,
  id: string,
  status: "successful" | "failed" | "cancelled" | "timed_out",
) {
  requirePermission(ctx, "sales.create");
  if (
    process.env.NODE_ENV === "production" ||
    process.env.MPESA_MODE !== "mock" ||
    process.env.DEMO_MODE !== "true"
  )
    fail(404, "NOT_FOUND", "Development provider unavailable");
  const intent = await one(
    ctx,
    "SELECT * FROM payment_intents WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, id],
  );
  branchAccess(ctx, intent.branch_id);
  if (
    intent.created_by !== ctx.actor.id &&
    !ctx.actor.permissions.includes("integrations.manage")
  )
    fail(403, "PAYMENT_OWNER", "Payment intent belongs to another operator");
  if (intent.status !== "pending")
    fail(409, "INTENT_FINALIZED", "A final provider outcome cannot be changed");
  if (!intent.checkout_id)
    fail(409, "INTENT_NOT_DISPATCHED", "Wait for the provider request");
  const receipt =
    "TEST" + randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  await ctx.db.query(
    "UPDATE mock_provider_transactions SET status=$1,receipt=$2 WHERE checkout_id=$3",
    [status, receipt, intent.checkout_id],
  );
  return { intent, receipt, status };
}
