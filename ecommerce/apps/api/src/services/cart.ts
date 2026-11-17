/**
 * Cart service. A cart belongs to exactly one owner: a registered customer or a
 * guest session (never both, enforced by a database CHECK).
 */
import { fail } from "../errors.ts";
import type { Database, Queryable } from "../db/index.ts";
import type { Actor } from "../http/context.ts";
import { config } from "../config.ts";
import {
  releaseCartReservations,
  releaseCartVariant,
  reserveStock,
} from "./reservations.ts";
import { toMoney } from "@ecom/shared";

export interface Cart {
  cart_id: string;
  customer_id: number | null;
  guest_session_id: string | null;
  status: string;
  currency: string;
  reservation_expires_at: string | null;
}

export function ownerOf(actor: Actor): {
  customerId?: number;
  guestSessionId?: string;
} {
  if (actor.kind === "customer") return { customerId: actor.customerId };
  if (actor.kind === "guest") return { guestSessionId: actor.guestSessionId };
  fail(403, "FORBIDDEN", "Only a customer or guest session can own a cart");
}

export async function ensureCart(tx: Queryable, actor: Actor): Promise<Cart> {
  const owner = ownerOf(actor);
  const column = owner.customerId ? "customer_id" : "guest_session_id";
  const value = owner.customerId ?? owner.guestSessionId;
  const existing = await tx.query<Cart>(
    `SELECT cart_id, customer_id, guest_session_id, status, currency, reservation_expires_at
       FROM cart WHERE ${column} = $1 AND status = 'active' FOR UPDATE`,
    [value],
  );
  if (existing.rows[0]) return existing.rows[0];

  const inserted = await tx.query<Cart>(
    `INSERT INTO cart(customer_id, guest_session_id) VALUES($1,$2)
     RETURNING cart_id, customer_id, guest_session_id, status, currency, reservation_expires_at`,
    [owner.customerId ?? null, owner.guestSessionId ?? null],
  );
  return inserted.rows[0]!;
}

export async function findCart(
  db: Queryable,
  actor: Actor,
): Promise<Cart | null> {
  const owner = ownerOf(actor);
  const column = owner.customerId ? "customer_id" : "guest_session_id";
  const value = owner.customerId ?? owner.guestSessionId;
  const rows = await db.query<Cart>(
    `SELECT cart_id, customer_id, guest_session_id, status, currency, reservation_expires_at
       FROM cart WHERE ${column} = $1 AND status = 'active' LIMIT 1`,
    [value],
  );
  return rows.rows[0] ?? null;
}

/**
 * Hand a guest's cart to the customer who just signed in.
 *
 * A shopper who fills a cart and then registers would otherwise be dropped into
 * an empty cart: the guest cart belongs to the guest session, and the customer
 * cart starts blank. The cart row is re-pointed instead of copied, so its lines
 * and their stock reservations (which hang off the cart id) stay exactly as
 * they were. Nothing moves when the customer already has an active cart of
 * their own, and an empty guest cart is simply left to expire.
 */
export async function adoptGuestCart(
  db: Database,
  input: { customerId: number; guestSessionId: string | null },
): Promise<string | null> {
  if (!input.guestSessionId) return null;
  return db.withTransaction(async (tx) => {
    const guestCart = await tx.query<{ cart_id: string }>(
      `SELECT cart_id FROM cart
        WHERE guest_session_id = $1 AND status = 'active'
          AND EXISTS (SELECT 1 FROM cart_item i WHERE i.cart_id = cart.cart_id)
        FOR UPDATE`,
      [input.guestSessionId],
    );
    const cartId = guestCart.rows[0]?.cart_id;
    if (!cartId) return null;

    const owned = await tx.query(
      "SELECT 1 FROM cart WHERE customer_id = $1 AND status = 'active'",
      [input.customerId],
    );
    if (owned.rows[0]) return null;

    await tx.query(
      `UPDATE cart SET customer_id = $1, guest_session_id = NULL, updated_at = now()
        WHERE cart_id = $2`,
      [input.customerId, cartId],
    );
    return cartId;
  });
}

export async function getCartView(db: Queryable, cartId: string) {
  const cart = await db.query<any>(
    `SELECT cart_id, currency, reservation_expires_at, created_at FROM cart WHERE cart_id = $1`,
    [cartId],
  );
  if (!cart.rows[0]) fail(404, "NOT_FOUND", "Cart not found");

  const items = await db.query<any>(
    `SELECT ci.cart_item_id, ci.variant_id, ci.quantity, ci.unit_price_snapshot::text AS unit_price_snapshot,
            v.sku, v.price::text AS price, v.qty_in_stock, v.is_active,
            p.product_id, p.product_name, p.slug,
            (SELECT json_agg(json_build_object('option', o.option_name, 'value', ov.value_name) ORDER BY o.sort_order)
               FROM variant_option_value vov
               JOIN product_option o ON o.option_id = vov.option_id
               JOIN product_option_value ov ON ov.option_value_id = vov.option_value_id
              WHERE vov.variant_id = v.variant_id) AS options,
            (SELECT image_url FROM product_image i WHERE i.product_id = p.product_id ORDER BY i.is_primary DESC, i.sort_order LIMIT 1) AS image_url,
            coalesce((SELECT sum(r.quantity) FROM inventory_reservation r
                       WHERE r.variant_id = v.variant_id AND r.status = 'active' AND r.expires_at > now()), 0)::int AS reserved,
            (SELECT min(r.expires_at)::text FROM inventory_reservation r
              WHERE r.cart_id = ci.cart_id AND r.status = 'active') AS reservation_expires_at
       FROM cart_item ci
       JOIN product_variant v ON v.variant_id = ci.variant_id
       JOIN product p ON p.product_id = v.product_id
      WHERE ci.cart_id = $1
      ORDER BY ci.created_at`,
    [cartId],
  );

  const mapped = items.rows.map((row) => {
    const available = Math.max(
      0,
      Number(row.qty_in_stock) - Number(row.reserved),
    );
    const price = toMoney(row.price);
    return {
      cart_item_id: row.cart_item_id,
      variant_id: row.variant_id,
      product_id: row.product_id,
      name: row.product_name,
      slug: row.slug,
      sku: row.sku,
      quantity: row.quantity,
      unit_price: price,
      line_total: (Number(price) * Number(row.quantity)).toFixed(2),
      available,
      in_stock: available > 0,
      available_for_quantity: available,
      options: row.options ?? [],
      image_url: row.image_url,
      reservation_expires_at: row.reservation_expires_at,
    };
  });

  const subtotal = mapped.reduce(
    (sum, item) => sum + Number(item.line_total),
    0,
  );
  return {
    cart_id: cart.rows[0].cart_id,
    currency: cart.rows[0].currency,
    reservation_expires_at: cart.rows[0].reservation_expires_at,
    items: mapped,
    item_count: mapped.reduce((sum, item) => sum + item.quantity, 0),
    subtotal: subtotal.toFixed(2),
  };
}

export async function addItem(
  tx: Queryable,
  input: { actor: Actor; variantId: number; quantity: number },
) {
  const cart = await ensureCart(tx, input.actor);
  const reservation = await reserveStock(tx, {
    owner: { cartId: cart.cart_id },
    variantId: input.variantId,
    quantity: input.quantity,
    ttlMinutes: config.cartReservationMinutes,
    absolute: false,
  });

  const variant = await tx.query<any>(
    "SELECT price::text AS price FROM product_variant WHERE variant_id = $1",
    [input.variantId],
  );
  await tx.query(
    `INSERT INTO cart_item(cart_id, variant_id, quantity, unit_price_snapshot)
     VALUES($1,$2,$3,$4)
     ON CONFLICT (cart_id, variant_id)
     DO UPDATE SET quantity = cart_item.quantity + EXCLUDED.quantity,
                   unit_price_snapshot = EXCLUDED.unit_price_snapshot,
                   updated_at = now()`,
    [cart.cart_id, input.variantId, input.quantity, variant.rows[0].price],
  );
  await tx.query(
    "UPDATE cart SET reservation_expires_at = now() + ($2 || ' minutes')::interval WHERE cart_id = $1",
    [cart.cart_id, String(config.cartReservationMinutes)],
  );
  return {
    cartId: cart.cart_id,
    reservation,
    view: await getCartView(tx, cart.cart_id),
  };
}

export async function updateItem(
  tx: Queryable,
  input: { actor: Actor; variantId: number; quantity: number },
) {
  const cart = await findCart(tx, input.actor);
  if (!cart) fail(404, "NOT_FOUND", "Your cart is empty");
  const item = await tx.query(
    "SELECT cart_item_id FROM cart_item WHERE cart_id = $1 AND variant_id = $2 FOR UPDATE",
    [cart.cart_id, input.variantId],
  );
  if (!item.rows[0]) fail(404, "NOT_FOUND", "That item is not in your cart");

  if (input.quantity === 0) {
    await releaseCartVariant(tx, cart.cart_id, input.variantId);
    await tx.query(
      "DELETE FROM cart_item WHERE cart_id = $1 AND variant_id = $2",
      [cart.cart_id, input.variantId],
    );
  } else {
    await reserveStock(tx, {
      owner: { cartId: cart.cart_id },
      variantId: input.variantId,
      quantity: input.quantity,
      ttlMinutes: config.cartReservationMinutes,
      absolute: true,
    });
    await tx.query(
      "UPDATE cart_item SET quantity = $3, updated_at = now() WHERE cart_id = $1 AND variant_id = $2",
      [cart.cart_id, input.variantId, input.quantity],
    );
  }
  await tx.query(
    "UPDATE cart SET reservation_expires_at = now() + ($2 || ' minutes')::interval WHERE cart_id = $1",
    [cart.cart_id, String(config.cartReservationMinutes)],
  );
  return { view: await getCartView(tx, cart.cart_id) };
}

export async function removeItem(
  tx: Queryable,
  input: { actor: Actor; variantId: number },
) {
  const cart = await findCart(tx, input.actor);
  if (!cart) fail(404, "NOT_FOUND", "Your cart is empty");
  await releaseCartVariant(tx, cart.cart_id, input.variantId);
  await tx.query(
    "DELETE FROM cart_item WHERE cart_id = $1 AND variant_id = $2",
    [cart.cart_id, input.variantId],
  );
  return { view: await getCartView(tx, cart.cart_id) };
}

export async function clearCart(tx: Queryable, input: { actor: Actor }) {
  const cart = await findCart(tx, input.actor);
  if (!cart) return { view: null };
  await releaseCartReservations(tx, cart.cart_id, "cart_cleared");
  await tx.query("DELETE FROM cart_item WHERE cart_id = $1", [cart.cart_id]);
  await tx.query(
    "UPDATE cart SET reservation_expires_at = NULL WHERE cart_id = $1",
    [cart.cart_id],
  );
  return { view: await getCartView(tx, cart.cart_id) };
}

export async function loadCartForCheckout(tx: Queryable, actor: Actor) {
  const cart = await findCart(tx, actor);
  if (!cart) fail(422, "EMPTY_CART", "Your cart is empty");
  const locked = await tx.query<Cart>(
    `SELECT cart_id, customer_id, guest_session_id, status, currency, reservation_expires_at
       FROM cart WHERE cart_id = $1 FOR UPDATE`,
    [cart.cart_id],
  );
  return locked.rows[0]!;
}

export async function cartLinesForCheckout(tx: Queryable, cartId: string) {
  const rows = await tx.query<any>(
    `SELECT ci.variant_id, ci.quantity, v.price::text AS price, v.qty_in_stock, v.sku, v.is_active,
            p.product_id, p.product_name, p.status AS product_status,
            coalesce((
              SELECT string_agg(o.option_name || ' / ' || ov.value_name, ', ' ORDER BY o.sort_order)
                FROM variant_option_value vov
                JOIN product_option o ON o.option_id = vov.option_id
                JOIN product_option_value ov ON ov.option_value_id = vov.option_value_id
               WHERE vov.variant_id = v.variant_id), '') AS option_summary,
            coalesce((
              SELECT json_agg(json_build_object('option', o.option_name, 'value', ov.value_name) ORDER BY o.sort_order)
                FROM variant_option_value vov
                JOIN product_option o ON o.option_id = vov.option_id
                JOIN product_option_value ov ON ov.option_value_id = vov.option_value_id
               WHERE vov.variant_id = v.variant_id), '[]'::json) AS options
       FROM cart_item ci
       JOIN product_variant v ON v.variant_id = ci.variant_id
       JOIN product p ON p.product_id = v.product_id
      WHERE ci.cart_id = $1
      ORDER BY ci.variant_id
      FOR UPDATE OF v`,
    [cartId],
  );
  if (!rows.rows.length) fail(422, "EMPTY_CART", "Your cart is empty");
  for (const row of rows.rows) {
    if (!row.is_active || row.product_status !== "active") {
      fail(409, "CONFLICT", `${row.product_name} is no longer available`);
    }
  }
  return rows.rows;
}
