/**
 * Stock reservations.
 *
 * A reservation does not move stock. It holds `quantity` units against a
 * variant until it is consumed (order placed), released (cart changed) or
 * expires. Availability is therefore:
 *
 *     available = qty_in_stock - sum(active, unexpired reservations)
 *
 * Concurrency: every decision locks the `product_variant` row first, so two
 * concurrent checkouts cannot both reserve the last unit. The database also
 * enforces the invariants (quantity > 0, one active reservation per cart+SKU,
 * non-negative stock).
 */
import { fail } from "../errors.ts";
import type { Queryable } from "../db/index.ts";

export interface ReservationOwner {
  cartId?: string;
  orderId?: number;
}

export async function lockVariant(tx: Queryable, variantId: number) {
  const rows = await tx.query<any>(
    `SELECT v.variant_id, v.sku, v.product_id, v.price::text AS price, v.qty_in_stock, v.is_active,
            p.product_name, p.status AS product_status
       FROM product_variant v
       JOIN product p ON p.product_id = v.product_id
      WHERE v.variant_id = $1
      FOR UPDATE OF v`,
    [variantId],
  );
  const variant = rows.rows[0];
  if (!variant) fail(404, "NOT_FOUND", "Product variant not found");
  if (!variant.is_active || variant.product_status !== "active") {
    fail(409, "CONFLICT", "This product is not available for sale");
  }
  return variant;
}

export async function reservedQuantity(
  tx: Queryable,
  variantId: number,
): Promise<number> {
  const rows = await tx.query<{ reserved: number }>(
    `SELECT coalesce(sum(quantity), 0)::int AS reserved
       FROM inventory_reservation
      WHERE variant_id = $1 AND status = 'active' AND expires_at > now()`,
    [variantId],
  );
  return Number(rows.rows[0]?.reserved ?? 0);
}

export async function availability(
  tx: Queryable,
  variantId: number,
  qtyInStock: number,
) {
  const reserved = await reservedQuantity(tx, variantId);
  return Math.max(0, Number(qtyInStock) - reserved);
}

export interface ReserveInput {
  owner: ReservationOwner;
  variantId: number;
  quantity: number;
  ttlMinutes: number;
  /** When true, `quantity` is the new total for this cart line (cart semantics). */
  absolute?: boolean;
}

/**
 * Create, extend or reduce one reservation. The caller must already be inside a
 * transaction; `lockVariant` is performed here to keep the invariant local.
 */
export async function reserveStock(tx: Queryable, input: ReserveInput) {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    fail(
      422,
      "VALIDATION_ERROR",
      "Reservation quantity must be a positive whole number",
    );
  }
  const variant = await lockVariant(tx, input.variantId);

  const existing = input.owner.cartId
    ? await tx.query<any>(
        `SELECT reservation_id, quantity FROM inventory_reservation
          WHERE cart_id = $1 AND variant_id = $2 AND status = 'active'
          FOR UPDATE`,
        [input.owner.cartId, input.variantId],
      )
    : await tx.query<any>(
        `SELECT reservation_id, quantity FROM inventory_reservation
          WHERE order_id = $1 AND variant_id = $2 AND status = 'active'
          FOR UPDATE`,
        [input.owner.orderId, input.variantId],
      );

  const current = Number(existing.rows[0]?.quantity ?? 0);
  const target = input.absolute ? input.quantity : current + input.quantity;
  const available = await availability(
    tx,
    input.variantId,
    variant.qty_in_stock,
  );

  if (target > available + current) {
    fail(
      409,
      "INSUFFICIENT_STOCK",
      `Only ${available + current} unit(s) of ${variant.product_name} are available`,
      {
        variant_id: input.variantId,
        sku: variant.sku,
        requested: target,
        available: available + current,
      },
    );
  }

  if (existing.rows[0]) {
    await tx.query(
      `UPDATE inventory_reservation
          SET quantity = $2, expires_at = now() + ($3 || ' minutes')::interval, updated_at = now()
        WHERE reservation_id = $1`,
      [existing.rows[0].reservation_id, target, String(input.ttlMinutes)],
    );
    return { reservationId: existing.rows[0].reservation_id, quantity: target };
  }

  const inserted = await tx.query<{ reservation_id: string }>(
    `INSERT INTO inventory_reservation(cart_id, order_id, variant_id, quantity, expires_at)
     VALUES($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)
     RETURNING reservation_id`,
    [
      input.owner.cartId ?? null,
      input.owner.orderId ?? null,
      input.variantId,
      target,
      String(input.ttlMinutes),
    ],
  );
  return { reservationId: inserted.rows[0]!.reservation_id, quantity: target };
}

export async function releaseReservation(
  tx: Queryable,
  input: { reservationId: string; reason: string },
) {
  await tx.query(
    `UPDATE inventory_reservation
        SET status = 'released', closed_at = now(), close_reason = $2, updated_at = now()
      WHERE reservation_id = $1 AND status = 'active'`,
    [input.reservationId, input.reason.slice(0, 60)],
  );
}

export async function releaseCartReservations(
  tx: Queryable,
  cartId: string,
  reason: string,
) {
  await tx.query(
    `UPDATE inventory_reservation
        SET status = 'released', closed_at = now(), close_reason = $2, updated_at = now()
      WHERE cart_id = $1 AND status = 'active'`,
    [cartId, reason.slice(0, 60)],
  );
}

export async function releaseCartVariant(
  tx: Queryable,
  cartId: string,
  variantId: number,
) {
  await tx.query(
    `UPDATE inventory_reservation
        SET status = 'released', closed_at = now(), close_reason = 'cart_item_removed', updated_at = now()
      WHERE cart_id = $1 AND variant_id = $2 AND status = 'active'`,
    [cartId, variantId],
  );
}

export interface ConsumeLine {
  variantId: number;
  quantity: number;
  unitPrice: string;
  productName: string;
  sku: string;
}

/**
 * Consume reservations for an order: stock leaves the warehouse here and only
 * here. Movements are keyed by order id so a retried checkout cannot double
 * decrement (`inventory_movement` unique index).
 */
export async function consumeForOrder(
  tx: Queryable,
  input: { orderId: number; cartId: string; lines: ConsumeLine[] },
) {
  for (const line of [...input.lines].sort(
    (a, b) => a.variantId - b.variantId,
  )) {
    const variant = await lockVariant(tx, line.variantId);
    const reservation = await tx.query<{
      reservation_id: string;
      quantity: number;
      status: string;
    }>(
      `SELECT reservation_id, quantity, status FROM inventory_reservation
        WHERE cart_id = $1 AND variant_id = $2
        ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1
        FOR UPDATE`,
      [input.cartId, line.variantId],
    );
    const row = reservation.rows[0];
    if (!row || row.status !== "active") {
      fail(
        409,
        "CART_RESERVATION_EXPIRED",
        "Your stock reservation expired. Please review your cart and try again.",
      );
    }
    if (Number(row.quantity) < line.quantity) {
      fail(
        409,
        "CART_RESERVATION_EXPIRED",
        "Your stock reservation is smaller than the cart line. Please refresh the cart.",
      );
    }

    const updated = await tx.query<{ quantity: number }>(
      `UPDATE product_variant SET qty_in_stock = qty_in_stock - $2, updated_at = now()
        WHERE variant_id = $1 AND qty_in_stock >= $2
        RETURNING qty_in_stock AS quantity`,
      [line.variantId, line.quantity],
    );
    if (!updated.rows[0]) {
      fail(
        409,
        "INSUFFICIENT_STOCK",
        "Stock changed while checking out. Please refresh your cart.",
      );
    }

    await tx.query(
      `UPDATE inventory_reservation
          SET status = 'consumed', consumed_at = now(), closed_at = now(), close_reason = 'order_placed', updated_at = now()
        WHERE reservation_id = $1`,
      [row.reservation_id],
    );

    await tx.query(
      `INSERT INTO inventory_movement(variant_id, quantity_delta, quantity_after, reason, source_type, source_id, reservation_id, actor, note)
       VALUES($1,$2,$3,'order_placed','order',$4,$5,'system','Checkout consumed reservation')
       ON CONFLICT DO NOTHING`,
      [
        line.variantId,
        -line.quantity,
        updated.rows[0]!.quantity,
        String(input.orderId),
        row.reservation_id,
      ],
    );
  }
}

/** Worker sweep: expire abandoned reservations in bounded batches. */
export async function expireStaleReservations(db: Queryable, limit = 200) {
  const rows = await db.query<{
    reservation_id: string;
    cart_id: string | null;
  }>(
    `SELECT reservation_id, cart_id FROM inventory_reservation
      WHERE status = 'active' AND expires_at <= now()
      ORDER BY expires_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  if (!rows.rows.length) return { expired: 0, carts: [] as string[] };
  const ids = rows.rows.map((row) => row.reservation_id);
  await db.query(
    `UPDATE inventory_reservation
        SET status = 'expired', closed_at = now(), close_reason = 'ttl_expired', updated_at = now()
      WHERE reservation_id = ANY($1::uuid[])`,
    [ids],
  );
  const carts = [
    ...new Set(
      rows.rows
        .map((row) => row.cart_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  return { expired: ids.length, carts };
}

/** Return reserved stock for a cancelled order (stock had already left). */
export async function restockOrder(
  tx: Queryable,
  input: {
    orderId: number;
    lines: Array<{ variantId: number; quantity: number }>;
    reason: "order_cancelled" | "refund_restock";
  },
) {
  for (const line of [...input.lines].sort(
    (a, b) => a.variantId - b.variantId,
  )) {
    const updated = await tx.query<{ quantity: number }>(
      `UPDATE product_variant SET qty_in_stock = qty_in_stock + $2, updated_at = now()
        WHERE variant_id = $1 RETURNING qty_in_stock AS quantity`,
      [line.variantId, line.quantity],
    );
    if (!updated.rows[0]) continue;
    await tx.query(
      `INSERT INTO inventory_movement(variant_id, quantity_delta, quantity_after, reason, source_type, source_id, actor)
       VALUES($1,$2,$3,$4,'order',$5,'system')
       ON CONFLICT DO NOTHING`,
      [
        line.variantId,
        line.quantity,
        updated.rows[0].quantity,
        input.reason,
        String(input.orderId),
      ],
    );
  }
}
