import { Router } from "express";
import { z } from "zod";
import { endpoint } from "../http/route.ts";
import { email, kenyanPhone, optionalText } from "@ecom/shared";
import type { RequestContext } from "../http/context.ts";
import {
  actorOwnsOrder,
  cancelOrder,
  findOrderByNumberAndEmail,
  getOrderView,
  listOrdersForActor,
  placeOrder,
  scheduleOrderSync,
} from "../services/orders.ts";
import { rateLimit } from "../services/security.ts";
import {
  beginPaymentIntent,
  schedulePaymentSync,
} from "../services/payments.ts";
import { fail } from "../errors.ts";

const checkoutBody = z
  .object({
    shipping_method_id: z.coerce.number().int().positive(),
    ship_name: z.string().trim().min(2).max(200),
    ship_address_line1: z.string().trim().min(3).max(255),
    ship_address_line2: optionalText,
    ship_city: z.string().trim().min(2).max(100),
    ship_region: optionalText,
    ship_postal_code: z.string().trim().max(20).optional(),
    ship_country: z.string().trim().max(100).optional(),
    email: email.optional(),
    phone: kenyanPhone.optional(),
    notes: optionalText,
    payment_phone: kenyanPhone.optional(),
  })
  .strict();

async function assertOwnership(ctx: RequestContext, orderId: number) {
  if (!Number.isInteger(orderId) || orderId <= 0)
    fail(422, "VALIDATION_ERROR", "Invalid order id");
  if (!(await actorOwnsOrder(ctx.db, ctx.actor!, orderId))) {
    fail(404, "NOT_FOUND", "Order not found");
  }
}

export function registerOrderRoutes(router: Router) {
  endpoint(
    router,
    "post",
    "/orders",
    {
      auth: "customer_or_guest",
      idempotent: true,
      status: 201,
      body: checkoutBody,
      summary:
        "Place an order from the current cart (idempotent, reserves and consumes stock)",
      tags: ["orders"],
    },
    async ({ ctx, body, tx }) => {
      if (ctx.actor!.kind === "admin")
        fail(403, "FORBIDDEN", "Use the admin order tools for manual orders");
      const key = ctx.req.header("Idempotency-Key")!;
      const placed = await placeOrder(tx!, {
        actor: ctx.actor!,
        body,
        idempotencyKey: key,
      });
      const orderId = placed.order.order_id;

      return {
        data: {
          order: placed.order as typeof placed.order & { status: string },
          payment: null as any,
        },
        // Provider and ERP calls must not run inside the database transaction:
        // they are external side effects and a rollback would strand them.
        afterCommit: async (data) => {
          const payment = await beginPaymentIntent(ctx.db, {
            orderId,
            transactionId: placed.transaction_id,
            phone: body.payment_phone ?? body.phone,
            email: placed.contact.email ?? undefined,
          });
          if (payment.status === "failed") {
            data.order = { ...data.order, status: "payment_failed" };
          }
          data.payment = payment;
          await scheduleOrderSync(ctx.db, orderId, placed.order.order_number);
          if (payment.status === "succeeded") {
            await schedulePaymentSync(ctx.db, orderId);
          }
        },
      };
    },
  );

  endpoint(
    router,
    "get",
    "/orders",
    {
      auth: "customer_or_guest",
      query: z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(50).default(10),
        })
        .strict(),
      summary: "List the signed-in customer's or guest's orders",
      tags: ["orders"],
    },
    async ({ ctx, query }) => ({
      data: await listOrdersForActor(ctx.db, ctx.actor!, {
        page: query.page,
        limit: query.limit,
      }),
    }),
  );

  endpoint(
    router,
    "get",
    "/orders/:orderId",
    {
      auth: "customer_or_guest",
      summary: "Order detail (own orders only)",
      tags: ["orders"],
    },
    async ({ ctx }) => {
      const orderId = Number((ctx.req.params as any).orderId);
      await assertOwnership(ctx, orderId);
      return { data: await getOrderView(ctx.db, orderId) };
    },
  );

  // Order lookup for people who are not signed in and may have lost the guest
  // cookie: the order number plus the address used at checkout. Both must match;
  // a miss is indistinguishable from a wrong email, and the attempt is rate
  // limited before the query runs.
  endpoint(
    router,
    "post",
    "/orders/lookup",
    {
      auth: "public",
      transactional: false,
      body: z
        .object({
          order_number: z.string().trim().min(4).max(40),
          email,
        })
        .strict(),
      summary: "Find one order by its number and the email used at checkout",
      tags: ["orders"],
    },
    async ({ ctx, body }) => {
      await rateLimit(ctx.db, `order-lookup:${ctx.ip}`, 10, 900);
      const order = await findOrderByNumberAndEmail(ctx.db, {
        orderNumber: body.order_number,
        email: body.email,
      });
      if (!order) {
        fail(
          404,
          "NOT_FOUND",
          "No order matches that number and email address",
        );
      }
      return { data: { order } };
    },
  );

  endpoint(
    router,
    "post",
    "/orders/:orderId/cancel",
    {
      auth: "customer_or_guest",
      body: z.object({ reason: z.string().trim().min(5).max(255) }).strict(),
      summary: "Cancel an unpaid order and restore stock",
      tags: ["orders"],
    },
    async ({ ctx, body, tx }) => {
      const orderId = Number((ctx.req.params as any).orderId);
      return {
        data: await cancelOrder(tx!, {
          actor: ctx.actor!,
          orderId,
          reason: body.reason,
        }),
      };
    },
  );
}
