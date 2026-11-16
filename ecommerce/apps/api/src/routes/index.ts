import { Router } from "express";
import { registerAuthRoutes } from "./auth.ts";
import { registerCatalogRoutes } from "./catalog.ts";
import { registerCartRoutes } from "./cart.ts";
import { registerOrderRoutes } from "./orders.ts";
import { registerWebhookRoutes } from "./webhooks.ts";
import { registerAdminRoutes } from "./admin.ts";

/** All versioned routes live under /api/v1. */
export function createApiRouter() {
  const router = Router();
  registerAuthRoutes(router);
  registerCatalogRoutes(router);
  registerCartRoutes(router);
  registerOrderRoutes(router);
  registerWebhookRoutes(router);
  registerAdminRoutes(router);
  return router;
}
