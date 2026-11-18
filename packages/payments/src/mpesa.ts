/**
 * M-Pesa (Safaricom Daraja) adapter.
 *
 * IMPORTANT: this adapter is written against the published Daraja contract but
 * has NOT been verified against a live merchant account in Phase 1. It is
 * disabled unless MPESA_MODE is explicitly `sandbox` or `live` and all
 * credentials are present. An STK prompt is a payment *request*, never proof of
 * payment: only a callback (or query) with ResultCode 0 is treated as success.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ErpErrorLike } from "./errors.ts";
import type {
  CreateIntentInput,
  PaymentIntentResult,
  PaymentProvider,
  RefundInput,
  RefundResult,
  WebhookInput,
  WebhookVerification,
} from "./types.ts";

export interface MpesaConfig {
  mode: "sandbox" | "live";
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  callbackSecret: string;
  callbackBaseUrl: string;
}

const timestamp = () => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

export class MpesaPaymentProvider implements PaymentProvider {
  readonly name = "mpesa" as const;
  readonly captureEnabled = true;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: MpesaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (
      !config.shortcode ||
      !config.passkey ||
      !config.consumerKey ||
      !config.consumerSecret
    ) {
      throw new ErpErrorLike(
        "MPESA_UNCONFIGURED",
        "M-Pesa credentials are incomplete",
      );
    }
    if (!config.callbackSecret || config.callbackSecret.length < 32) {
      throw new ErpErrorLike(
        "MPESA_UNCONFIGURED",
        "MPESA_CALLBACK_SECRET must be at least 32 characters",
      );
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000)
      return this.token.value;
    const basic = Buffer.from(
      `${this.config.consumerKey}:${this.config.consumerSecret}`,
    ).toString("base64");
    const response = await this.fetchImpl(
      `${this.config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { authorization: `Basic ${basic}` } },
    );
    if (!response.ok)
      throw new ErpErrorLike(
        "MPESA_AUTH_FAILED",
        `Daraja OAuth failed (${response.status})`,
        true,
      );
    const payload: any = await response.json();
    if (!payload?.access_token)
      throw new ErpErrorLike(
        "MPESA_AUTH_FAILED",
        "Daraja returned no access token",
      );
    this.token = {
      value: payload.access_token,
      expiresAt: Date.now() + Number(payload.expires_in ?? 3599) * 1000,
    };
    return this.token.value;
  }

  async createIntent(input: CreateIntentInput): Promise<PaymentIntentResult> {
    if (!input.phone)
      throw new ErpErrorLike(
        "MPESA_PHONE_REQUIRED",
        "An M-Pesa phone number is required",
      );
    const phone = input.phone.replace(/\D/g, "");
    const normalized = phone.startsWith("254")
      ? phone
      : phone.replace(/^0/, "254");
    const ts = timestamp();
    const password = Buffer.from(
      `${this.config.shortcode}${this.config.passkey}${ts}`,
    ).toString("base64");
    const token = await this.accessToken();
    const callbackUrl = `${this.config.callbackBaseUrl.replace(/\/+$/, "")}/api/v1/webhooks/payments/mpesa`;

    const response = await this.fetchImpl(
      `${this.config.baseUrl}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          BusinessShortCode: this.config.shortcode,
          Password: password,
          Timestamp: ts,
          TransactionType: "CustomerPayBillOnline",
          Amount: Number(input.amount),
          PartyA: normalized,
          PartyB: this.config.shortcode,
          PhoneNumber: normalized,
          CallBackURL: callbackUrl,
          AccountReference: input.orderNumber.slice(0, 12),
          TransactionDesc: input.description.slice(0, 13),
        }),
      },
    );
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ResponseCode !== "0") {
      return {
        provider: this.name,
        providerReference: null,
        status: "failed",
        instructions: "M-Pesa did not accept the payment request.",
        raw: payload,
      };
    }
    return {
      provider: this.name,
      providerReference: String(payload.CheckoutRequestID),
      status: "requires_action",
      instructions:
        "Enter your M-Pesa PIN on your phone to authorise the payment.",
      raw: {
        MerchantRequestID: payload.MerchantRequestID,
        CheckoutRequestID: payload.CheckoutRequestID,
      },
    };
  }

  verifyWebhook({ headers, rawBody }: WebhookInput): WebhookVerification {
    const provided = headers["x-webhook-signature"] ?? "";
    const expected = createHmac("sha256", this.config.callbackSecret)
      .update(rawBody)
      .digest("hex");
    const valid =
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

    let parsed: any = {};
    try {
      parsed = JSON.parse(rawBody || "{}");
    } catch {
      return {
        valid: false,
        eventId: "",
        eventType: "mpesa.unparseable",
        providerReference: null,
        status: "failed",
        reason: "Body is not valid JSON",
        raw: null,
      };
    }

    const callback = parsed?.Body?.stkCallback ?? parsed?.stkCallback ?? {};
    const reference = callback.CheckoutRequestID
      ? String(callback.CheckoutRequestID)
      : null;
    const resultCode = Number(callback.ResultCode ?? parsed.ResultCode ?? -1);
    const status =
      resultCode === 0
        ? "succeeded"
        : resultCode === 1032
          ? "failed"
          : "failed";
    const metadata: Array<{ Name: string; Value?: string | number }> =
      callback?.CallbackMetadata?.Item ?? [];
    const amountItem = metadata.find((item) => item.Name === "Amount");
    return {
      valid,
      eventId: `${reference ?? "unknown"}:${resultCode}`,
      eventType: "mpesa.stk_callback",
      providerReference: reference,
      amount: amountItem ? String(amountItem.Value) : undefined,
      status,
      reason: valid ? String(callback.ResultDesc ?? "") : "Signature mismatch",
      raw: parsed,
    };
  }

  async refund(): Promise<RefundResult> {
    // Daraja reversals require a separate merchant approval; deliberately not
    // implemented so the system cannot claim an unverified refund.
    throw new ErpErrorLike(
      "MPESA_REFUND_UNSUPPORTED",
      "M-Pesa refunds require the merchant reversal API and are not enabled in Phase 1",
    );
  }
}
