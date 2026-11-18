import { Router } from "express";
import { endpoint } from "../http/route.ts";
import {
  ingestPaymentWebhook,
  schedulePaymentSync,
} from "../services/payments.ts";
import { config } from "../config.ts";

export function registerWebhookRoutes(router: Router) {
  endpoint(
    router,
    "post",
    "/webhooks/payments/:provider",
    {
      auth: "public",
      transactional: false,
      summary:
        "Provider payment webhook (HMAC-verified, deduplicated by event id)",
      tags: ["webhooks"],
    },
    async ({ ctx }) => {
      const provider = String((ctx.req.params as any).provider);
      const rawBody = (ctx.req as any).rawBody ?? "";
      const headers: Record<string, string | undefined> = {
        "content-type": ctx.req.header("content-type"),
        "x-webhook-signature": ctx.req.header("x-webhook-signature"),
        "x-request-id": ctx.req.header("x-request-id"),
      };
      const result = await ingestPaymentWebhook(ctx.db, {
        providerName: provider,
        headers,
        rawBody,
      });
      if (result.processed && result.orderId)
        await schedulePaymentSync(ctx.db, result.orderId);
      return {
        status: 200,
        data: {
          received: true,
          duplicate: result.duplicate,
          processed: result.processed,
          reason: result.reason ?? null,
          environment:
            config.env === "production" ? "production" : "non-production",
        },
      };
    },
  );
}
