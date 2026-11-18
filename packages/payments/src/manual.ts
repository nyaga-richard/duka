import type {
  CreateIntentInput,
  PaymentIntentResult,
  PaymentProvider,
  RefundInput,
  RefundResult,
  WebhookVerification,
} from "./types.ts";

/**
 * Manual settlement: the order is placed and paid outside the system (cash on
 * delivery, bank transfer, or a back-office reconciliation). It never claims a
 * card was charged and it accepts no webhooks.
 */
export class ManualPaymentProvider implements PaymentProvider {
  readonly name = "manual" as const;
  readonly captureEnabled = false;

  async createIntent(input: CreateIntentInput): Promise<PaymentIntentResult> {
    return {
      provider: this.name,
      providerReference: `manual:${input.orderNumber}`,
      status: "pending",
      instructions:
        "Order placed. Payment is collected on delivery or by bank transfer and confirmed by the store team.",
      raw: { mode: "manual" },
    };
  }

  verifyWebhook(): WebhookVerification {
    return {
      valid: false,
      eventId: "",
      eventType: "manual.none",
      providerReference: null,
      status: "pending",
      reason: "The manual provider does not emit webhooks",
      raw: null,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return {
      status: "pending",
      providerReference: `manual-refund:${input.idempotencyKey}`,
      raw: {
        mode: "manual",
        note: "Refund must be paid out and confirmed by the store team",
      },
    };
  }
}
