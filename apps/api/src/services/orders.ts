/**
 * Orders: checkout, reads, cancellation, admin transitions, shipments.
 *
 * Checkout is a single database transaction. Stock leaves only after every
 * reservation, price and shipping check passes; the payment provider is called
 * after commit so a provider timeout can never roll back a real order (the
 * pending payment transaction is retried and visible to operators).
 */
import type { Database, Queryable } from "../db/index.ts";
import type { Actor } from "../http/context.ts";
import { fail } from "../errors.ts";
import { config } from "../config.ts";
import { audit } from "./security.ts";
import { cartLinesForCheckout, loadCartForCheckout } from "./cart.ts";
import {
  consumeForOrder,
  releaseCartReservations,
  restockOrder,
} from "./reservations.ts";
import { enqueueSyncJob } from "./sync.ts";
import { toMoney } from "@ecom/shared";

export const ORDER_STATUS_NAMES: Record<number, string> = {
  1: "cart",
  2: "placed",
  3: "paid",
  4: "processing",
  5: "shipped",
  6: "delivered",
  7: "cancelled",
  8: "refunded",
  9: "payment_failed",
};

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  placed: ["paid", "payment_failed", "cancelled"],
  payment_failed: ["paid", "cancelled"],
  paid: ["processing", "shipped", "cancelled", "refunded"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered", "refunded"],
  delivered: ["refunded"],
  cancelled: [],
  refunded: [],
};

export async function nextOrderNumber(tx: Queryable): Promise<string> {
  const counter = await tx.query<{ name: string; value: number }>(
    `INSERT INTO app_counter(name, value)
     SELECT 'order:' || to_char(now() AT TIME ZONE 'Africa/Nairobi', 'YYYYMMDD'), 1
     ON CONFLICT (name) DO UPDATE SET value = app_counter.value + 1
     RETURNING name, value`,
  );
  const row = counter.rows[0]!;
  const day = row.name.split(":")[1]!;
  return `EC-${day}-${String(row.value).padStart(5, "0")}`;
}

export interface CheckoutInput {
  shipping_method_id: number;
  ship_name: string;
  ship_address_line1: string;
  ship_address_line2?: string;
  ship_city: string;
  ship_region?: string;
  ship_postal_code?: string;
  ship_country?: string;
  email?: string;
  phone?: string;
  notes?: string;
  payment_phone?: string;
}

export async function placeOrder(
  tx: Queryable,
  input: { actor: Actor; body: CheckoutInput; idempotencyKey: string },
) {
  const { actor, body, idempotencyKey } = input;
  const cart = await loadCartForCheckout(tx, actor);
  const lines = await cartLinesForCheckout(tx, cart.cart_id);

  const shipping = await tx.query<any>(
    "SELECT shipping_method_id, method_name, price::text AS price FROM shipping_method WHERE shipping_method_id = $1 AND is_active",
    [body.shipping_method_id],
  );
  if (!shipping.rows[0])
    fail(422, "VALIDATION_ERROR", "Unknown or inactive shipping method");

  const subtotal = lines.reduce(
    (sum, line) => sum + Number(line.price) * Number(line.quantity),
    0,
  );
  const shippingCost = Number(shipping.rows[0].price);
  const discount = 0;
  const total = subtotal - discount + shippingCost;

  const email =
    body.email ??
    (actor.kind === "customer"
      ? actor.email
      : actor.kind === "guest"
        ? actor.email
        : null);
  if (actor.kind === "guest" && !email) {
    fail(
      422,
      "VALIDATION_ERROR",
      "An email address is required for guest checkout",
    );
  }
  if (actor.kind === "guest" && body.email && !actor.email) {
    await tx.query(
      "UPDATE guest_session SET email = $2 WHERE guest_session_id = $1",
      [actor.guestSessionId, body.email],
    );
  }

  const orderNumber = await nextOrderNumber(tx);
  const order = await tx.query<any>(
    `INSERT INTO customer_order(
        customer_id, guest_session_id, order_status_id, order_date, shipping_method_id, shipping_cost,
        ship_name, ship_address_line1, ship_address_line2, ship_city, ship_region, ship_postal_code, ship_country,
        subtotal, discount_total, order_total, placed_at, email, payment_status, reservation_expires_at,
        notes, tax_total, erp_state, channel, order_number, currency)
     VALUES($1,$2,2, now(), $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), $15,'pending',
            now() + ($16 || ' minutes')::interval, $17, 0, $18, 'web', $19, 'KES')
     RETURNING order_id, order_number, order_status_id, payment_status, order_total::text AS order_total, placed_at`,
    [
      actor.kind === "customer" ? actor.customerId : null,
      actor.kind === "guest" ? actor.guestSessionId : null,
      shipping.rows[0].shipping_method_id,
      shippingCost.toFixed(2),
      body.ship_name,
      body.ship_address_line1,
      body.ship_address_line2 ?? null,
      body.ship_city,
      body.ship_region ?? null,
      body.ship_postal_code ?? null,
      body.ship_country ?? "Kenya",
      subtotal.toFixed(2),
      discount.toFixed(2),
      total.toFixed(2),
      email,
      String(config.cartReservationMinutes),
      body.notes ?? null,
      config.erp.enabled ? "pending" : "disabled",
      orderNumber,
    ],
  );
  const orderRow = order.rows[0]!;

  for (const line of [...lines].sort((a, b) => a.variant_id - b.variant_id)) {
    const unitPrice = toMoney(line.price);
    const lineTotal = (Number(unitPrice) * Number(line.quantity)).toFixed(2);
    await tx.query(
      `INSERT INTO order_line(order_id, variant_id, product_id, quantity, product_name, sku, option_summary,
                              unit_price, discount_amount, line_total, tax_amount, option_snapshot)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,0,$10)`,
      [
        orderRow.order_id,
        line.variant_id,
        line.product_id,
        line.quantity,
        line.product_name,
        line.sku,
        line.option_summary || null,
        unitPrice,
        lineTotal,
        JSON.stringify(line.options ?? []),
      ],
    );
  }

  await consumeForOrder(tx, {
    orderId: orderRow.order_id,
    cartId: cart.cart_id,
    lines: lines.map((line) => ({
      variantId: line.variant_id,
      quantity: line.quantity,
      unitPrice: toMoney(line.price),
      productName: line.product_name,
      sku: line.sku,
    })),
  });

  const provider =
    config.payments.mode === "disabled" ? "manual" : config.payments.mode;
  const transaction = await tx.query<{ transaction_id: string }>(
    `INSERT INTO payment_transaction(order_id, provider, amount, status, idempotency_key, request_payload)
     VALUES($1,$2,$3,'pending',$4,$5) RETURNING transaction_id`,
    [
      orderRow.order_id,
      provider,
      total.toFixed(2),
      idempotencyKey,
      JSON.stringify({
        order_number: orderNumber,
        phone: body.phone ?? body.payment_phone ?? null,
      }),
    ],
  );

  await tx.query(
    "UPDATE cart SET status = 'converted', converted_order_id = $2 WHERE cart_id = $1",
    [cart.cart_id, orderRow.order_id],
  );

  await audit(tx, {
    actorType: actor.kind,
    actorId:
      actor.kind === "admin"
        ? actor.adminUserId
        : actor.kind === "customer"
          ? String(actor.customerId)
          : actor.guestSessionId,
    action: "order.placed",
    entityType: "customer_order",
    entityId: orderRow.order_id,
    after: {
      order_number: orderNumber,
      total: total.toFixed(2),
      lines: lines.length,
    },
  });

  return {
    order: {
      order_id: orderRow.order_id,
      order_number: orderNumber,
      status: "placed",
      payment_status: "pending",
      total: total.toFixed(2),
      currency: "KES",
    },
    transaction_id: transaction.rows[0]!.transaction_id,
    provider,
    contact: { email, phone: body.phone ?? body.payment_phone ?? null },
  };
}

/** Queue the ERP projection of a new order (no-op when integration is disabled). */
export async function scheduleOrderSync(
  db: Database,
  orderId: number,
  orderNumber: string,
) {
  if (!config.erp.enabled) return null;
  return enqueueSyncJob(db, {
    entityType: "order",
    direction: "push",
    operation: "push_order_document",
    localId: orderId,
    payload: { orderId, orderNumber },
  });
}

export async function getOrderView(db: Queryable, orderId: number) {
  const orders = await db.query<any>(
    `SELECT o.*, s.status_name,
            o.subtotal::text AS subtotal, o.discount_total::text AS discount_total,
            o.shipping_cost::text AS shipping_cost, o.order_total::text AS order_total,
            o.tax_total::text AS tax_total, sm.method_name
       FROM customer_order o
       JOIN order_status s ON s.order_status_id = o.order_status_id
       LEFT JOIN shipping_method sm ON sm.shipping_method_id = o.shipping_method_id
      WHERE o.order_id = $1`,
    [orderId],
  );
  const order = orders.rows[0];
  if (!order) fail(404, "NOT_FOUND", "Order not found");

  const [lines, payments, shipments] = await Promise.all([
    db.query<any>(
      `SELECT order_line_id, variant_id, product_id, quantity, product_name, sku, option_summary,
              unit_price::text AS unit_price, discount_amount::text AS discount_amount, line_total::text AS line_total,
              tax_amount::text AS tax_amount, option_snapshot
         FROM order_line WHERE order_id = $1 ORDER BY order_line_id`,
      [orderId],
    ),
    db.query<any>(
      `SELECT payment_id, provider_reference, amount::text AS amount, payment_status, created_at
         FROM payment WHERE order_id = $1 ORDER BY payment_id`,
      [orderId],
    ),
    db.query<any>(
      `SELECT shipment_id, carrier, tracking_number, tracking_url, status, shipped_at, delivered_at
         FROM shipment WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
    ),
  ]);

  return {
    order_id: order.order_id,
    order_number: order.order_number,
    status: order.status_name,
    payment_status: order.payment_status,
    erp_state: order.erp_state,
    currency: order.currency,
    placed_at: order.placed_at ?? order.created_at,
    notes: order.notes,
    totals: {
      subtotal: toMoney(order.subtotal),
      discount: toMoney(order.discount_total),
      shipping: toMoney(order.shipping_cost),
      tax: toMoney(order.tax_total),
      total: toMoney(order.order_total),
    },
    shipping: {
      method: order.method_name,
      name: order.ship_name,
      address_line1: order.ship_address_line1,
      address_line2: order.ship_address_line2,
      city: order.ship_city,
      region: order.ship_region,
      postal_code: order.ship_postal_code,
      country: order.ship_country,
    },
    email: order.email,
    items: lines.rows.map((line) => ({
      ...line,
      unit_price: toMoney(line.unit_price),
      discount_amount: toMoney(line.discount_amount),
      line_total: toMoney(line.line_total),
      tax_amount: toMoney(line.tax_amount),
    })),
    payments: payments.rows.map((payment) => ({
      ...payment,
      amount: toMoney(payment.amount),
    })),
    shipments: shipments.rows,
  };
}

/**
 * Resolve one order from its number plus the email used at checkout.
 *
 * This is the only unauthenticated way to read an order, so it is deliberately
 * narrow: both halves must match, the caller learns nothing about which half
 * was wrong, and the route applies a rate limit before calling it. The full view
 * is returned because the email has already proved ownership of that order.
 */
export async function findOrderByNumberAndEmail(
  db: Queryable,
  input: { orderNumber: string; email: string },
): Promise<Awaited<ReturnType<typeof getOrderView>> | null> {
  const row = await db.query<{ order_id: number }>(
    `SELECT order_id FROM customer_order
      WHERE upper(order_number) = upper($1) AND lower(email) = lower($2)
      ORDER BY order_id DESC LIMIT 1`,
    [input.orderNumber.trim(), input.email.trim()],
  );
  if (!row.rows[0]) return null;
  return getOrderView(db, row.rows[0].order_id);
}

export async function listOrdersForActor(
  db: Queryable,
  actor: Actor,
  query: { page: number; limit: number },
) {
  const ownerClause =
    actor.kind === "customer"
      ? "o.customer_id = $1"
      : "o.guest_session_id = $1";
  const ownerValue =
    actor.kind === "customer"
      ? actor.customerId
      : actor.kind === "guest"
        ? actor.guestSessionId
        : null;
  if (!ownerValue)
    fail(403, "FORBIDDEN", "Only a customer or guest can list their orders");
  const offset = (query.page - 1) * query.limit;
  const rows = await db.query<any>(
    `SELECT o.order_id, o.order_number, o.order_total::text AS order_total, o.placed_at, o.payment_status,
            o.email, s.status_name, (SELECT count(*) FROM order_line l WHERE l.order_id = o.order_id)::int AS line_count,
            count(*) OVER()::int AS _count
       FROM customer_order o JOIN order_status s ON s.order_status_id = o.order_status_id
      WHERE ${ownerClause}
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3`,
    [ownerValue, query.limit, offset],
  );
  return {
    items: rows.rows.map((row) => ({
      ...row,
      order_total: toMoney(row.order_total),
      status: row.status_name,
    })),
    page: query.page,
    limit: query.limit,
    total: rows.rows[0]?._count ?? 0,
  };
}

export async function actorOwnsOrder(
  db: Queryable,
  actor: Actor,
  orderId: number,
) {
  if (actor.kind === "admin") return true;
  const column = actor.kind === "customer" ? "customer_id" : "guest_session_id";
  const value =
    actor.kind === "customer" ? actor.customerId : actor.guestSessionId;
  const rows = await db.query(
    `SELECT 1 FROM customer_order WHERE order_id = $1 AND ${column} = $2`,
    [orderId, value],
  );
  return rows.rowCount > 0;
}

export async function cancelOrder(
  tx: Queryable,
  input: { actor: Actor; orderId: number; reason: string; admin?: boolean },
) {
  if (!input.admin && !(await actorOwnsOrder(tx, input.actor, input.orderId))) {
    fail(404, "NOT_FOUND", "Order not found");
  }
  const orders = await tx.query<any>(
    `SELECT o.*, s.status_name FROM customer_order o
       JOIN order_status s ON s.order_status_id = o.order_status_id
      WHERE o.order_id = $1 FOR UPDATE OF o`,
    [input.orderId],
  );
  const order = orders.rows[0];
  if (!order) fail(404, "NOT_FOUND", "Order not found");
  if (!["placed", "payment_failed"].includes(order.status_name)) {
    fail(
      409,
      "INVALID_STATE_TRANSITION",
      `An order in status "${order.status_name}" cannot be cancelled`,
    );
  }
  const paid = await tx.query(
    "SELECT 1 FROM payment_transaction WHERE order_id = $1 AND status IN ('succeeded','partially_refunded') LIMIT 1",
    [input.orderId],
  );
  if (paid.rowCount > 0) {
    fail(
      409,
      "INVALID_STATE_TRANSITION",
      "This order has a captured payment. Refund it instead of cancelling.",
    );
  }

  const lines = await tx.query<any>(
    "SELECT variant_id, quantity FROM order_line WHERE order_id = $1",
    [input.orderId],
  );
  await restockOrder(tx, {
    orderId: input.orderId,
    lines: lines.rows.map((line) => ({
      variantId: line.variant_id,
      quantity: line.quantity,
    })),
    reason: "order_cancelled",
  });

  await tx.query(
    `UPDATE customer_order SET order_status_id = 7, cancelled_at = now(), cancellation_reason = $2,
                               payment_status = 'unpaid', updated_at = now()
      WHERE order_id = $1`,
    [input.orderId, input.reason],
  );
  await tx.query(
    `UPDATE inventory_reservation SET status = 'released', closed_at = now(), close_reason = 'order_cancelled'
      WHERE order_id = $1 AND status = 'active'`,
    [input.orderId],
  );
  await tx.query(
    `UPDATE payment_transaction SET status = 'cancelled', updated_at = now(), completed_at = now()
      WHERE order_id = $1 AND status IN ('pending','requires_action')`,
    [input.orderId],
  );
  await audit(tx, {
    actorType: input.actor.kind,
    actorId:
      input.actor.kind === "admin"
        ? input.actor.adminUserId
        : String(
            (input.actor as any).customerId ??
              (input.actor as any).guestSessionId,
          ),
    action: "order.cancelled",
    entityType: "customer_order",
    entityId: input.orderId,
    after: { reason: input.reason },
  });
  return getOrderView(tx, input.orderId);
}

export async function adminListOrders(
  db: Queryable,
  query: { status?: string; q?: string; page: number; limit: number },
) {
  const offset = (query.page - 1) * query.limit;
  const search = `%${(query.q ?? "").trim().slice(0, 120)}%`;
  const rows = await db.query<any>(
    `SELECT o.order_id, o.order_number, o.order_total::text AS order_total, o.placed_at, o.payment_status,
            o.erp_state, s.status_name, o.email,
            (SELECT count(*) FROM order_line l WHERE l.order_id = o.order_id)::int AS line_count,
            count(*) OVER()::int AS _count
       FROM customer_order o JOIN order_status s ON s.order_status_id = o.order_status_id
      WHERE ($1::text IS NULL OR s.status_name = $1)
        AND ($2 = '%%' OR o.order_number ILIKE $2 OR coalesce(o.email,'') ILIKE $2 OR coalesce(o.ship_name,'') ILIKE $2)
      ORDER BY o.created_at DESC LIMIT $3 OFFSET $4`,
    [query.status ?? null, search, query.limit, offset],
  );
  return {
    items: rows.rows.map((row) => ({
      ...row,
      order_total: toMoney(row.order_total),
      status: row.status_name,
    })),
    page: query.page,
    limit: query.limit,
    total: rows.rows[0]?._count ?? 0,
  };
}

export async function transitionOrder(
  tx: Queryable,
  input: { adminUserId: string; orderId: number; to: string; reason: string },
) {
  const orders = await tx.query<any>(
    `SELECT o.order_id, o.order_status_id, s.status_name FROM customer_order o
       JOIN order_status s ON s.order_status_id = o.order_status_id
      WHERE o.order_id = $1 FOR UPDATE OF o`,
    [input.orderId],
  );
  const order = orders.rows[0];
  if (!order) fail(404, "NOT_FOUND", "Order not found");
  const allowed = ALLOWED_TRANSITIONS[order.status_name] ?? [];
  if (!allowed.includes(input.to)) {
    fail(
      409,
      "INVALID_STATE_TRANSITION",
      `Cannot move an order from "${order.status_name}" to "${input.to}"`,
    );
  }
  if (input.to === "paid") {
    fail(
      422,
      "VALIDATION_ERROR",
      "Record a payment instead of setting the order to paid directly",
    );
  }
  const status = await tx.query<{ order_status_id: number }>(
    "SELECT order_status_id FROM order_status WHERE status_name = $1",
    [input.to],
  );
  if (!status.rows[0])
    fail(422, "VALIDATION_ERROR", `Unknown order status: ${input.to}`);

  if (input.to === "cancelled") {
    const lines = await tx.query<any>(
      "SELECT variant_id, quantity FROM order_line WHERE order_id = $1",
      [input.orderId],
    );
    await restockOrder(tx, {
      orderId: input.orderId,
      lines: lines.rows.map((line) => ({
        variantId: line.variant_id,
        quantity: line.quantity,
      })),
      reason: "order_cancelled",
    });
    await tx.query(
      "UPDATE customer_order SET cancelled_at = now(), cancellation_reason = $2 WHERE order_id = $1",
      [input.orderId, input.reason],
    );
  }

  await tx.query(
    "UPDATE customer_order SET order_status_id = $2, updated_at = now() WHERE order_id = $1",
    [input.orderId, status.rows[0].order_status_id],
  );

  await audit(tx, {
    actorType: "admin",
    actorId: input.adminUserId,
    action: "order.status_changed",
    entityType: "customer_order",
    entityId: input.orderId,
    before: { status: order.status_name },
    after: { status: input.to, reason: input.reason },
  });
  return getOrderView(tx, input.orderId);
}

export async function createShipment(
  tx: Queryable,
  input: {
    adminUserId: string;
    orderId: number;
    carrier: string;
    trackingNumber?: string;
    trackingUrl?: string;
    lines: Array<{ orderLineId: number; quantity: number }>;
  },
) {
  const orders = await tx.query<any>(
    `SELECT o.order_id, s.status_name FROM customer_order o
       JOIN order_status s ON s.order_status_id = o.order_status_id WHERE o.order_id = $1 FOR UPDATE OF o`,
    [input.orderId],
  );
  const order = orders.rows[0];
  if (!order) fail(404, "NOT_FOUND", "Order not found");
  if (!["paid", "processing", "shipped"].includes(order.status_name)) {
    fail(
      409,
      "INVALID_STATE_TRANSITION",
      "Only paid or processing orders can be shipped",
    );
  }

  const orderLines = await tx.query<any>(
    "SELECT order_line_id, quantity FROM order_line WHERE order_id = $1",
    [input.orderId],
  );
  const available = new Map(
    orderLines.rows.map((line) => [
      Number(line.order_line_id),
      Number(line.quantity),
    ]),
  );
  for (const line of input.lines) {
    const remaining = available.get(line.orderLineId);
    if (remaining === undefined)
      fail(
        422,
        "VALIDATION_ERROR",
        `Order line ${line.orderLineId} is not on this order`,
      );
    if (line.quantity <= 0 || line.quantity > remaining) {
      fail(
        422,
        "VALIDATION_ERROR",
        "Shipment quantity exceeds the ordered quantity",
      );
    }
  }

  const shipment = await tx.query<{ shipment_id: string }>(
    `INSERT INTO shipment(order_id, carrier, tracking_number, tracking_url, status, shipped_at)
     VALUES($1,$2,$3,$4,'dispatched', now()) RETURNING shipment_id`,
    [
      input.orderId,
      input.carrier,
      input.trackingNumber ?? null,
      input.trackingUrl ?? null,
    ],
  );
  for (const line of input.lines) {
    await tx.query(
      "INSERT INTO shipment_item(shipment_id, order_line_id, quantity) VALUES($1,$2,$3)",
      [shipment.rows[0]!.shipment_id, line.orderLineId, line.quantity],
    );
  }
  if (order.status_name !== "shipped") {
    await tx.query(
      "UPDATE customer_order SET order_status_id = 5, updated_at = now() WHERE order_id = $1",
      [input.orderId],
    );
  }
  await audit(tx, {
    actorType: "admin",
    actorId: input.adminUserId,
    action: "shipment.created",
    entityType: "shipment",
    entityId: shipment.rows[0]!.shipment_id,
    after: {
      order_id: input.orderId,
      carrier: input.carrier,
      tracking_number: input.trackingNumber ?? null,
    },
  });
  return {
    shipment_id: shipment.rows[0]!.shipment_id,
    order: await getOrderView(tx, input.orderId),
  };
}

export async function updateShipmentStatus(
  tx: Queryable,
  input: {
    adminUserId: string;
    shipmentId: string;
    status: string;
    trackingUrl?: string;
  },
) {
  const allowed = [
    "dispatched",
    "in_transit",
    "delivered",
    "failed",
    "returned",
  ];
  if (!allowed.includes(input.status))
    fail(422, "VALIDATION_ERROR", "Unsupported shipment status");
  const shipments = await tx.query<any>(
    "SELECT shipment_id, order_id FROM shipment WHERE shipment_id = $1 FOR UPDATE",
    [input.shipmentId],
  );
  const shipment = shipments.rows[0];
  if (!shipment) fail(404, "NOT_FOUND", "Shipment not found");
  await tx.query(
    `UPDATE shipment SET status = $2::text,
            shipped_at = CASE WHEN $2::text = 'dispatched' AND shipped_at IS NULL THEN now() ELSE shipped_at END,
            delivered_at = CASE WHEN $2::text = 'delivered' THEN now() ELSE delivered_at END,
            tracking_url = coalesce($3, tracking_url), updated_at = now()
      WHERE shipment_id = $1`,
    [input.shipmentId, input.status, input.trackingUrl ?? null],
  );
  if (input.status === "delivered") {
    await tx.query(
      "UPDATE customer_order SET order_status_id = 6, updated_at = now() WHERE order_id = $1",
      [shipment.order_id],
    );
  }
  await audit(tx, {
    actorType: "admin",
    actorId: input.adminUserId,
    action: "shipment.status_changed",
    entityType: "shipment",
    entityId: input.shipmentId,
    after: { status: input.status },
  });
  return getOrderView(tx, shipment.order_id);
}

/** Release an abandoned cart's reservations when a customer abandons checkout. */
export async function abandonCart(tx: Queryable, cartId: string) {
  await releaseCartReservations(tx, cartId, "checkout_abandoned");
  await tx.query(
    "UPDATE cart SET status = 'abandoned' WHERE cart_id = $1 AND status = 'active'",
    [cartId],
  );
}
