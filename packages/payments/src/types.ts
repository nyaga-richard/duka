/** Provider-agnostic payment boundary. No provider is enabled by default. */
export type PaymentIntentStatus =
  | "pending"
  | "requires_action"
  | "succeeded"
  | "failed";

export interface CreateIntentInput {
  orderId: number;
  orderNumber: string;
  amount: string;
  currency: string;
  idempotencyKey: string;
  description: string;
  phone?: string;
  email?: string;
}

export interface PaymentIntentResult {
  provider: string;
  providerReference: string | null;
  status: PaymentIntentStatus;
  /** Human-readable next step (e.g. "pay on delivery"). Never renders card data. */
  instructions?: string;
  redirectUrl?: string;
  raw?: unknown;
}

export interface WebhookInput {
  headers: Record<string, string | undefined>;
  rawBody: string;
}

export interface WebhookVerification {
  valid: boolean;
  /** Provider-unique event id; deduplicated in payment_webhook. */
  eventId: string;
  eventType: string;
  providerReference: string | null;
  amount?: string;
  status: "succeeded" | "failed" | "pending";
  reason?: string;
  raw: unknown;
}

export interface RefundInput {
  providerReference: string;
  amount: string;
  idempotencyKey: string;
  reason: string;
}

export interface RefundResult {
  status: "succeeded" | "failed" | "pending";
  providerReference: string | null;
  raw?: unknown;
}

export interface PaymentProvider {
  readonly name: "manual" | "mpesa" | "fake" | "card";
  readonly captureEnabled: boolean;
  createIntent(input: CreateIntentInput): Promise<PaymentIntentResult>;
  verifyWebhook(input: WebhookInput): WebhookVerification;
  refund(input: RefundInput): Promise<RefundResult>;
}
