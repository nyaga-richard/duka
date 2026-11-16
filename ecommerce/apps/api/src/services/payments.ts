/**
 * Payment ledger, provider boundary and webhook ingestion.
 *
 * Phase 1 rules:
 *  - the only enabled provider by default is `manual` (no capture);
 *  - a provider webhook is the ONLY thing that can mark a captured payment
 *    successful (never the browser, never an STK prompt);
 *  - every webhook is stored once per (provider, event_id) and processing is
 *    idempotent, so provider retries cannot double-post money;
 *  - refunds are capped by the captured amount of the original transaction.
 */
import { createHash } from "node:crypto";
import type { Database, Queryable } from "../db/index.ts";
import { config } from "../config.ts";
import { fail } from "../errors.ts";
import { logger } from "../logger.ts";
import { audit } from "./security.ts";
import { enqueueSyncJob } from "./sync.ts";
import { restockOrder } from "./reservations.ts";
import { getOrderView } from "./orders.ts";
import { createPaymentProvider, type PaymentProvider } from "@ecom/payments";
import { toMoney } from "@ecom/shared";

let provider: PaymentProvider | null = null;

export function paymentProvider(): PaymentProvider {
  if (!provider) {
    provider = createPaymentProvider({
      mode: config.payments.mode,
      captureEnabled: config.payments.captureEnabled,
      mpesa: config.payments.mpesa,
    });
  }
  return provider;
}

/** Test seam: reset the cached provider after changing configuration. */
export function resetPaymentProviderForTest() {
  if (config.env === "production") throw new Error("Test seam is unavailable in production");
  provider = null;
}

export async function beginPaymentIntent(
  db: Database,
  input: { orderId: number; transactionId: string; phone?: string; email?: string },
) {
  const orders = await db.query<any>(
    `SELECT o.order_id, o.order_number, o.order_total::text AS total, o.currency, o.email,
            t.transaction_id, t.amount::text AS amount, t.idempotency_key, t.status
       FROM customer_order o JOIN payment_transaction t ON t.order_id = o.order_id
      WHERE o.order_id = $1 AND t.transaction_id = $2`,
    [input.orderId, input.transactionId],
  );
  const order = orders.rows[0];
  if (!order) fail(404, "NOT_FOUND", "Payment transaction not found");
  if (["succeeded", "failed", "cancelled"].includes(order.status)) {
    return { provider: config.payments.mode, status: order.status, reference: null, instructions: undefined };
  }

  const active = paymentProvider();
  try {
    const intent = await active.createIntent({
      orderId: order.order_id,
      orderNumber: order.order_number,
      amount: toMoney(order.amount),
      currency: order.currency,
      idempotencyKey: order.idempotency_key,
      description: `Order ${order.order_number}`,
      phone: input.phone,
      email: input.email ?? order.email,
    });

    await db.query(
      `UPDATE payment_transaction
          SET provider_reference = $2, status = $3::text, response_payload = $4, updated_at = now(),
              failure_reason = CASE WHEN $3::text = 'failed' THEN coalesce($5, 'Provider rejected the payment') ELSE NULL END,
              completed_at = CASE WHEN $3::text IN ('succeeded','failed') THEN now() ELSE completed_at END
        WHERE transaction_id = $1`,
      [order.transaction_id, intent.providerReference, intent.status, JSON.stringify(intent.raw ?? null), intent.instructions ?? null],
    );

    if (intent.status === "failed") {
      await db.query(
        "UPDATE customer_order SET payment_status = 'failed', order_status_id = 9, updated_at = now() WHERE order_id = $1",
        [order.order_id],
      );
    } else {
      await db.query("UPDATE customer_order SET payment_status = 'pending', updated_at = now() WHERE order_id = $1", [
        order.order_id,
      ]);
    }

    return {
      provider: intent.provider,
      status: intent.status,
      reference: intent.providerReference,
      instructions: intent.instructions ?? null,
      redirect_url: intent.redirectUrl ?? null,
    };
  } catch (error: any) {
    logger.warn({ orderId: order.order_id, err: error?.message }, "payment intent failed");
    await db.query(
      `UPDATE payment_transaction SET status = 'failed', failure_reason = $2, updated_at = now(), completed_at = now()
        WHERE transaction_id = $1`,
      [order.transaction_id, String(error?.message ?? "Provider unavailable").slice(0, 250)],
    );
    await db.query(
      "UPDATE customer_order SET payment_status = 'failed', order_status_id = 9, updated_at = now() WHERE order_id = $1",
      [order.order_id],
    );
    return {
      provider: active.name,
      status: "failed" as const,
      reference: null,
      instructions: "The payment provider is unavailable. Your order is saved; choose another payment method or contact support.",
    };
  }
}

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  processed: boolean;
  reason?: string;
  orderId?: number;
}

export async function ingestPaymentWebhook(
  db: Database,
  input: { providerName: string; headers: Record<string, string | undefined>; rawBody: string },
): Promise<IngestResult> {
  const active = paymentProvider();
  if (active.name !== input.providerName) {
    fail(404, "NOT_FOUND", `No active webhook provider named ${input.providerName}`);
  }

  const verification = active.verifyWebhook({ headers: input.headers, rawBody: input.rawBody });
  const eventId = verification.eventId || `unidentified:${createHash("sha256").update(input.rawBody).digest("hex").slice(0, 32)}`;

  const inserted = await db.query<{ webhook_id: string }>(
    `INSERT INTO payment_webhook(provider, event_id, event_type, signature_valid, payload, headers, status, error)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING webhook_id`,
    [
      active.name,
      eventId,
      verification.eventType,
      verification.valid,
      input.rawBody,
      JSON.stringify({ "content-type": input.headers["content-type"] ?? null }),
      verification.valid ? "received" : "ignored",
      verification.valid ? null : verification.reason ?? "Invalid signature",
    ],
  );

  if (inserted.rowCount === 0) {
    return { accepted: true, duplicate: true, processed: true, reason: "Duplicate event" };
  }
  const webhookId = inserted.rows[0]!.webhook_id;

  if (!verification.valid) {
    fail(401, "FORBIDDEN", "Webhook signature is invalid; the event was recorded and rejected");
  }
  if (!verification.providerReference) {
    await db.query("UPDATE payment_webhook SET status='failed', error=$2, processed_at=now() WHERE webhook_id=$1", [
      webhookId,
      "No provider reference in the event",
    ]);
    return { accepted: true, duplicate: false, processed: false, reason: "No provider reference" };
  }

  return db.withTransaction(async (tx) => {
    const transactions = await tx.query<any>(
      `SELECT t.*, o.order_id, o.payment_status, o.order_status_id
         FROM payment_transaction t JOIN customer_order o ON o.order_id = t.order_id
        WHERE t.provider = $1 AND t.provider_reference = $2
        FOR UPDATE OF t, o`,
      [active.name, verification.providerReference],
    );
    const transaction = transactions.rows[0];
    if (!transaction) {
      await tx.query(
        "UPDATE payment_webhook SET status='failed', error=$2, processed_at=now(), attempts=attempts+1 WHERE webhook_id=$1",
        [webhookId, "No matching payment transaction"],
      );
      return { accepted: true, duplicate: false, processed: false, reason: "No matching payment transaction" };
    }

    if (verification.status === "succeeded") {
      if (transaction.status !== "succeeded") {
        await tx.query(
          `UPDATE payment_transaction SET status='succeeded', updated_at=now(), completed_at=now(), failure_reason=NULL
            WHERE transaction_id=$1`,
          [transaction.transaction_id],
        );
        await tx.query(
          `INSERT INTO payment(order_id, provider_reference, amount, payment_status, currency, payment_transaction_id)
           VALUES($1,$2,$3,'succeeded','KES',$4)
           ON CONFLICT DO NOTHING`,
          [transaction.order_id, verification.providerReference, toMoney(transaction.amount), transaction.transaction_id],
        );
        await tx.query(
          "UPDATE customer_order SET payment_status='paid', order_status_id = CASE WHEN order_status_id IN (2,9) THEN 3 ELSE order_status_id END, updated_at=now() WHERE order_id=$1",
          [transaction.order_id],
        );
        await audit(tx, {
          actorType: "system",
          action: "payment.succeeded",
          entityType: "payment_transaction",
          entityId: transaction.transaction_id,
          after: { provider: active.name, reference: verification.providerReference, amount: toMoney(transaction.amount) },
        });
      }
    } else if (verification.status === "failed") {
      if (transaction.status !== "succeeded") {
        await tx.query(
          `UPDATE payment_transaction SET status='failed', failure_reason=$2, updated_at=now(), completed_at=now()
            WHERE transaction_id=$1`,
          [transaction.transaction_id, verification.reason ?? "Provider reported failure"],
        );
        await tx.query(
          "UPDATE customer_order SET payment_status='failed', order_status_id = CASE WHEN order_status_id = 3 THEN order_status_id ELSE 9 END, updated_at=now() WHERE order_id=$1",
          [transaction.order_id],
        );
      }
    }

    await tx.query(
      "UPDATE payment_webhook SET status='processed', processed_at=now(), attempts=attempts+1, error=NULL WHERE webhook_id=$1",
      [webhookId],
    );
    return { accepted: true, duplicate: false, processed: true, orderId: transaction.order_id };
  });
}

/** Queue ERP projections after a payment outcome (no-op when ERP is disabled). */
export async function schedulePaymentSync(db: Database, orderId: number) {
  if (!config.erp.enabled) return;
  const payments = await db.query<any>(
    "SELECT payment_id FROM payment WHERE order_id = $1 ORDER BY payment_id DESC LIMIT 1",
    [orderId],
  );
  if (payments.rows[0]) {
    await enqueueSyncJob(db, {
      entityType: "payment",
      direction: "push",
      operation: "push_payment",
      localId: payments.rows[0].payment_id,
      payload: { orderId, paymentId: payments.rows[0].payment_id },
    });
  }
  await enqueueSyncJob(db, {
    entityType: "order",
    direction: "push",
    operation: "push_order_document",
    localId: orderId,
    payload: { orderId },
  });
}

export async function recordManualPayment(
  tx: Queryable,
  input: {
    adminUserId: string;
    orderId: number;
    amount: string;
    reference: string;
    note?: string;
  },
) {
  const orders = await tx.query<any>(
    `SELECT o.order_id, o.order_total::text AS total, o.payment_status, s.status_name
       FROM customer_order o JOIN order_status s ON s.order_status_id = o.order_status_id
      WHERE o.order_id = $1 FOR UPDATE OF o`,
    [input.orderId],
  );
  const order = orders.rows[0];
  if (!order) fail(404, "NOT_FOUND", "Order not found");
  const amount = toMoney(input.amount);
  if (Number(amount) <= 0) fail(422, "VALIDATION_ERROR", "Payment amount must be greater than zero");

  const captured = await tx.query<{ total: string }>(
    "SELECT coalesce(sum(amount),0)::text AS total FROM payment WHERE order_id = $1 AND payment_status = 'succeeded'",
    [input.orderId],
  );
  const remaining = Number(order.total) - Number(captured.rows[0]?.total ?? 0);
  if (Number(amount) > remaining + 0.001) {
    fail(422, "VALIDATION_ERROR", `Payment exceeds the outstanding balance of ${remaining.toFixed(2)}`);
  }

  const transaction = await tx.query<{ transaction_id: string }>(
    `INSERT INTO payment_transaction(order_id, provider, provider_reference, amount, status, idempotency_key, completed_at, response_payload)
     VALUES($1,'manual',$2,$3,'succeeded',$4, now(), $5) RETURNING transaction_id`,
    [input.orderId, input.reference, amount, `admin-manual:${input.orderId}:${input.reference}`.slice(0, 120), JSON.stringify({ note: input.note ?? null, admin_user_id: input.adminUserId })],
  );
  await tx.query(
    `INSERT INTO payment(order_id, provider_reference, amount, payment_status, currency, payment_transaction_id)
     VALUES($1,$2,$3,'succeeded','KES',$4)`,
    [input.orderId, input.reference, amount, transaction.rows[0]!.transaction_id],
  );
  const newPaymentStatus = Number(amount) + Number(captured.rows[0]?.total ?? 0) >= Number(order.total) ? "paid" : "pending";
  await tx.query(
    `UPDATE customer_order SET payment_status = $2::text,
            order_status_id = CASE WHEN $2::text = 'paid' AND order_status_id IN (2,9) THEN 3 ELSE order_status_id END,
            updated_at = now()
      WHERE order_id = $1`,
    [input.orderId, newPaymentStatus],
  );
  await audit(tx, {
    actorType: "admin",
    actorId: input.adminUserId,
    action: "payment.recorded_manually",
    entityType: "payment",
    entityId: transaction.rows[0]!.transaction_id,
    after: { order_id: input.orderId, amount, reference: input.reference },
  });
  return { transactionId: transaction.rows[0]!.transaction_id, paymentStatus: newPaymentStatus, order: await getOrderView(tx, input.orderId) };
}

export async function requestRefund(
  db: Database,
  input: {
    adminUserId: string;
    orderId: number;
    transactionId?: string;
    amount: string;
    reason: string;
    restock: boolean;
    /** Deterministic per caller retry; enforced by a unique index. */
    idempotencyKey: string;
  },
) {
  const amount = toMoney(input.amount);
  if (Number(amount) <= 0) fail(422, "VALIDATION_ERROR", "Refund amount must be greater than zero");

  const replay = await db.query<any>(
    `SELECT refund_id, order_id, amount::text AS amount, currency, status, reason, created_at, processed_at
       FROM refund WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  if (replay.rows[0]) {
    return { ...replay.rows[0], amount: toMoney(replay.rows[0].amount), replayed: true };
  }

  const prepared = await db.withTransaction(async (tx) => {
    const transactions = await tx.query<any>(
      `SELECT transaction_id, provider, provider_reference, amount::text AS amount, status
         FROM payment_transaction
        WHERE order_id = $1 AND status IN ('succeeded','partially_refunded')
          AND ($2::uuid IS NULL OR transaction_id = $2)
        ORDER BY created_at LIMIT 1
        FOR UPDATE`,
      [input.orderId, input.transactionId ?? null],
    );
    const transaction = transactions.rows[0];
    if (!transaction) fail(409, "CONFLICT", "There is no captured payment to refund");
    if (!transaction.provider_reference) fail(409, "CONFLICT", "The payment has no provider reference");

    const refunded = await tx.query<{ total: string }>(
      `SELECT coalesce(sum(amount),0)::text AS total FROM refund
        WHERE payment_transaction_id = $1 AND status IN ('requested','approved','processing','succeeded')`,
      [transaction.transaction_id],
    );
    const refundable = Number(transaction.amount) - Number(refunded.rows[0]?.total ?? 0);
    if (Number(amount) > refundable + 0.001) {
      fail(422, "VALIDATION_ERROR", `Refund exceeds the refundable amount of ${refundable.toFixed(2)}`);
    }

    const refund = await tx.query<any>(
      `INSERT INTO refund(order_id, payment_transaction_id, amount, reason, status, idempotency_key, requested_by)
       VALUES($1,$2,$3,$4,'processing',$5,$6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING refund_id, amount::text AS amount, status`,
      [input.orderId, transaction.transaction_id, amount, input.reason, input.idempotencyKey, input.adminUserId],
    );
    if (!refund.rows[0]) {
      fail(409, "CONFLICT", "This refund request is already being processed");
    }

    if (input.restock) {
      const lines = await tx.query<any>("SELECT variant_id, quantity FROM order_line WHERE order_id = $1", [input.orderId]);
      await restockOrder(tx, {
        orderId: input.orderId,
        lines: lines.rows.map((line) => ({ variantId: line.variant_id, quantity: line.quantity })),
        reason: "refund_restock",
      });
    }

    const totalRefunded = Number(refunded.rows[0]?.total ?? 0) + Number(amount);
    const orderPaymentStatus = totalRefunded >= Number(transaction.amount) ? "refunded" : "partially_refunded";
    await tx.query("UPDATE customer_order SET payment_status = $2, updated_at = now() WHERE order_id = $1", [
      input.orderId,
      orderPaymentStatus,
    ]);
    if (orderPaymentStatus === "refunded") {
      await tx.query("UPDATE customer_order SET order_status_id = 8, updated_at = now() WHERE order_id = $1", [input.orderId]);
      await tx.query("UPDATE payment_transaction SET status = 'refunded', updated_at = now() WHERE transaction_id = $1", [
        transaction.transaction_id,
      ]);
    } else {
      await tx.query("UPDATE payment_transaction SET status = 'partially_refunded', updated_at = now() WHERE transaction_id = $1", [
        transaction.transaction_id,
      ]);
    }

    await audit(tx, {
      actorType: "admin",
      actorId: input.adminUserId,
      action: "refund.requested",
      entityType: "refund",
      entityId: refund.rows[0]!.refund_id,
      after: { order_id: input.orderId, amount, reason: input.reason, restock: input.restock },
    });

    return {
      refundId: refund.rows[0]!.refund_id as string,
      amount,
      providerReference: transaction.provider_reference as string,
      idempotencyKey: `refund:${refund.rows[0]!.refund_id}`,
    };
  });

  // Provider refund happens after commit: money movement is external.
  try {
    const result = await paymentProvider().refund({
      providerReference: prepared.providerReference,
      amount: prepared.amount,
      idempotencyKey: prepared.idempotencyKey,
      reason: input.reason,
    });
    // Provider vocabulary differs (e.g. manual settlement is asynchronous), so
    // map it onto the refund status machine instead of storing it verbatim.
    const providerStatus =
      result.status === "succeeded" ? "succeeded" : result.status === "failed" ? "failed" : "processing";
    await db.query(
      `UPDATE refund SET status = $2::text, provider_reference = $3,
              processed_at = CASE WHEN $2::text IN ('succeeded','failed') THEN now() ELSE processed_at END, updated_at = now()
        WHERE refund_id = $1`,
      [prepared.refundId, providerStatus, result.providerReference ?? null],
    );
  } catch (error: any) {
    await db.query(
      `UPDATE refund SET status = 'failed', updated_at = now(), processed_at = now() WHERE refund_id = $1`,
      [prepared.refundId],
    );
    logger.warn({ refundId: prepared.refundId, err: error?.message }, "provider refund failed");
  }

  if (config.erp.enabled) {
    await enqueueSyncJob(db, {
      entityType: "refund",
      direction: "push",
      operation: "push_refund",
      localId: prepared.refundId,
      payload: { orderId: input.orderId, refundId: prepared.refundId },
    });
  }

  const refund = await db.query<any>(
    `SELECT refund_id, order_id, amount::text AS amount, currency, status, reason, created_at, processed_at
       FROM refund WHERE refund_id = $1`,
    [prepared.refundId],
  );
  return { ...refund.rows[0], amount: toMoney(refund.rows[0].amount), replayed: false };
}
