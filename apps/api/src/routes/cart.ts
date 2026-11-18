import { Router } from "express";
import { z } from "zod";
import { endpoint } from "../http/route.ts";
import { nonNegativeInt } from "@ecom/shared";
import type { Actor } from "../http/context.ts";
import { fail } from "../errors.ts";
import { createGuestSession, setSessionCookie } from "../services/auth.ts";
import {
  addItem,
  clearCart,
  findCart,
  getCartView,
  removeItem,
  updateItem,
} from "../services/cart.ts";

async function actorForCartWrite(
  ctx: any,
): Promise<{ actor: Actor; csrf: string | null }> {
  if (ctx.actor) return { actor: ctx.actor, csrf: null };
  const guest = await createGuestSession(
    ctx.db,
    { email: null },
    { ip: ctx.ip, userAgent: ctx.req.header("user-agent") },
  );
  setSessionCookie(ctx.res, "guest", guest.token);
  return {
    actor: {
      kind: "guest",
      guestSessionId: guest.guestSessionId,
      sessionId: guest.guestSessionId,
      email: null,
      csrf: guest.csrf,
    },
    csrf: guest.csrf,
  };
}

export function registerCartRoutes(router: Router) {
  endpoint(
    router,
    "get",
    "/cart",
    {
      auth: "public",
      summary: "Current cart with live prices and availability",
      tags: ["cart"],
    },
    async ({ ctx }) => {
      if (!ctx.actor)
        return {
          data: {
            items: [],
            item_count: 0,
            subtotal: "0.00",
            currency: "KES",
            reservation_expires_at: null,
          },
        };
      if (ctx.actor.kind === "admin")
        return {
          data: { items: [], item_count: 0, subtotal: "0.00", currency: "KES" },
        };
      const cart = await findCart(ctx.db, ctx.actor);
      if (!cart)
        return {
          data: {
            items: [],
            item_count: 0,
            subtotal: "0.00",
            currency: "KES",
            reservation_expires_at: null,
          },
        };
      return { data: await getCartView(ctx.db, cart.cart_id) };
    },
  );

  endpoint(
    router,
    "post",
    "/cart/items",
    {
      auth: "public",
      transactional: false,
      status: 201,
      body: z
        .object({
          variant_id: z.coerce.number().int().positive(),
          quantity: nonNegativeInt.refine(
            (v) => v > 0 && v <= 20,
            "Quantity must be 1–20",
          ),
        })
        .strict(),
      summary: "Add a variant to the cart and hold stock",
      tags: ["cart"],
    },
    async ({ ctx, body }) => {
      const { actor, csrf } = await actorForCartWrite(ctx);
      const result = await ctx.db.withTransaction((tx) =>
        addItem(tx, {
          actor,
          variantId: body.variant_id,
          quantity: body.quantity,
        }),
      );
      return {
        data: {
          cart_id: result.cartId,
          reservation_expires_at: result.view.reservation_expires_at,
          cart: result.view,
          ...(csrf ? { csrf_token: csrf } : {}),
        },
      };
    },
  );

  endpoint(
    router,
    "patch",
    "/cart/items/:variantId",
    {
      auth: "customer_or_guest",
      transactional: false,
      body: z.object({ quantity: nonNegativeInt.max(20) }).strict(),
      summary: "Set a cart line quantity (0 removes it)",
      tags: ["cart"],
    },
    async ({ ctx, body }) => {
      const variantId = Number((ctx.req.params as any).variantId);
      if (!Number.isInteger(variantId) || variantId <= 0) {
        fail(422, "VALIDATION_ERROR", "variantId must be a positive integer");
      }
      const result = await ctx.db.withTransaction((tx) =>
        updateItem(tx, {
          actor: ctx.actor!,
          variantId,
          quantity: body.quantity,
        }),
      );
      return { data: result.view };
    },
  );

  endpoint(
    router,
    "delete",
    "/cart/items/:variantId",
    {
      auth: "customer_or_guest",
      transactional: false,
      summary: "Remove a variant from the cart and release its hold",
      tags: ["cart"],
    },
    async ({ ctx }) => {
      const variantId = Number((ctx.req.params as any).variantId);
      const result = await ctx.db.withTransaction((tx) =>
        removeItem(tx, { actor: ctx.actor!, variantId }),
      );
      return { data: result.view };
    },
  );

  endpoint(
    router,
    "post",
    "/cart/clear",
    {
      auth: "customer_or_guest",
      transactional: false,
      summary: "Empty the cart and release all holds",
      tags: ["cart"],
    },
    async ({ ctx }) => {
      const result = await ctx.db.withTransaction((tx) =>
        clearCart(tx, { actor: ctx.actor! }),
      );
      return { data: result.view };
    },
  );
}
