import { createHmac } from "node:crypto";
import type { CreateIntentInput, PaymentIntentResult, PaymentProvider, RefundInput, RefundResult, WebhookInput, WebhookVerification } from "./types.ts";

/**
 * Deterministic provider used only by automated tests. Refuses to run in
 * production (enforced here and in config.ts).
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake" as const;
  readonly captureEnabled = true;

  constructor(private readonly options: { secret?: string; failWebhookSignature?: boolean } = {}) {
    if (process.env.NODE_ENV === "production") throw new Error("FakePaymentProvider is test-only");
  }

  async createIntent(input: CreateIntentInput): Promise<PaymentIntentResult> {
    return {
      provider: this.name,
      providerReference: `fake-${input.orderNumber}`,
      status: "requires_action",
      instructions: "POST the signed test webhook to complete this order.",
      raw: { amount: input.amount, currency: input.currency },
    };
  }

  verifyWebhook({ headers, rawBody }: WebhookInput): WebhookVerification {
    const secret = this.options.secret ?? "test-secret";
    const provided = headers["x-webhook-signature"] ?? "";
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const valid = !this.options.failWebhookSignature && provided === expected;
    const parsed = JSON.parse(rawBody || "{}");
    return {
      valid,
      eventId: String(parsed.event_id ?? parsed.reference ?? ""),
      eventType: String(parsed.event_type ?? "payment.updated"),
      providerReference: parsed.reference ? String(parsed.reference) : null,
      amount: parsed.amount ? String(parsed.amount) : undefined,
      status: parsed.status === "succeeded" ? "succeeded" : parsed.status === "failed" ? "failed" : "pending",
      reason: valid ? undefined : "Signature mismatch",
      raw: parsed,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return { status: "succeeded", providerReference: `fake-refund-${input.idempotencyKey}`, raw: { amount: input.amount } };
  }
}
