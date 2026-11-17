/**
 * Back-office API. Every route requires an admin session plus a specific
 * permission. Customer sessions can never reach these paths because the auth
 * mode is `admin` and admin sessions live in their own cookie/table.
 */
import { Router } from "express";
import { z } from "zod";
import { endpoint } from "../http/route.ts";
import {
  moneyString,
  nonNegativeInt,
  optionalText,
  slugify,
} from "@ecom/shared";
import { fail } from "../errors.ts";
import {
  adminListOrders,
  createShipment,
  getOrderView,
  transitionOrder,
  updateShipmentStatus,
} from "../services/orders.ts";
import {
  recordManualPayment,
  requestRefund,
  schedulePaymentSync,
} from "../services/payments.ts";
import { beginPaymentIntent } from "../services/payments.ts";
import {
  enqueueSyncJob,
  processSyncJobs,
  pullCatalog,
  pullInventory,
  pushCustomer,
  pushOrderDocument,
  syncOverview,
} from "../services/sync.ts";
import {
  createProduct,
  getAdminProduct,
  insertVariant,
  setProductImage,
  updateProduct,
  updateVariant,
} from "../services/catalog-admin.ts";
import { getErpAdapter, erpEnabled } from "../integrations/erp.ts";
import { ERP_CAPABILITIES } from "@ecom/erp-adapter";
import { audit } from "../services/security.ts";

const pageQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export function registerAdminRoutes(router: Router) {
  endpoint(
    router,
    "get",
    "/admin/orders",
    {
      auth: "admin",
      permissions: ["orders.read"],
      query: pageQuery
        .extend({
          status: z.string().max(30).optional(),
          q: z.string().max(120).optional(),
        })
        .strict(),
      summary: "Search orders across the store",
      tags: ["admin"],
    },
    async ({ ctx, query }) => ({ data: await adminListOrders(ctx.db, query) }),
  );

  endpoint(
    router,
    "get",
    "/admin/orders/:orderId",
    {
      auth: "admin",
      permissions: ["orders.read"],
      summary: "Full order detail",
      tags: ["admin"],
    },
    async ({ ctx }) => ({
      data: await getOrderView(ctx.db, Number((ctx.req.params as any).orderId)),
    }),
  );

  endpoint(
    router,
    "patch",
    "/admin/orders/:orderId/status",
    {
      auth: "admin",
      permissions: ["orders.write"],
      body: z
        .object({
          status: z.string().trim().min(2).max(30),
          reason: z.string().trim().min(5).max(255),
        })
        .strict(),
      summary:
        "Move an order through fulfilment (payment status is not settable here)",
      tags: ["admin"],
    },
    async ({ ctx, body, tx }) => ({
      data: await transitionOrder(tx!, {
        adminUserId: ctx.actor!.kind === "admin" ? ctx.actor!.adminUserId : "",
        orderId: Number((ctx.req.params as any).orderId),
        to: body.status,
        reason: body.reason,
      }),
    }),
  );

  endpoint(
    router,
    "post",
    "/admin/orders/:orderId/payments",
    {
      auth: "admin",
      permissions: ["payments.write"],
      status: 201,
      body: z
        .object({
          amount: moneyString,
          reference: z.string().trim().min(3).max(120),
          note: z.string().trim().max(500).optional(),
        })
        .strict(),
      summary: "Record a confirmed manual payment (cash/bank) against an order",
      tags: ["admin"],
    },
    async ({ ctx, body, tx }) => ({
      data: await recordManualPayment(tx!, {
        adminUserId: ctx.actor!.kind === "admin" ? ctx.actor!.adminUserId : "",
        orderId: Number((ctx.req.params as any).orderId),
        amount: body.amount,
        reference: body.reference,
        note: body.note,
      }),
    }),
  );

  endpoint(
    router,
    "post",
    "/admin/orders/:orderId/payment-intent",
    {
      auth: "admin",
      permissions: ["payments.write"],
      transactional: false,
      body: z
        .object({
          transaction_id: z.uuid().optional(),
          phone: z.string().trim().max(20).optional(),
        })
        .strict(),
      summary: "Retry the provider payment intent for a pending order",
      tags: ["admin"],
    },
    async ({ ctx, body }) => {
      const orderId = Number((ctx.req.params as any).orderId);
      const transaction = body.transaction_id
        ? { rows: [{ transaction_id: body.transaction_id }] }
        : await ctx.db.query<{ transaction_id: string }>(
            "SELECT transaction_id FROM payment_transaction WHERE order_id = $1 AND status IN ('pending','requires_action','failed') ORDER BY created_at DESC LIMIT 1",
            [orderId],
          );
      const row = (transaction as any).rows[0];
      if (!row)
        fail(
          409,
          "CONFLICT",
          "There is no pending payment transaction for this order",
        );
      const payment = await beginPaymentIntent(ctx.db, {
        orderId,
        transactionId: row.transaction_id,
        phone: body.phone,
      });
      if (payment.status === "succeeded")
        await schedulePaymentSync(ctx.db, orderId);
      return { data: payment };
    },
  );

  endpoint(
    router,
    "post",
    "/admin/orders/:orderId/shipments",
    {
      auth: "admin",
      permissions: ["shipments.write"],
      status: 201,
      body: z
        .object({
          carrier: z.string().trim().min(2).max(80),
          tracking_number: z.string().trim().min(2).max(120).optional(),
          tracking_url: z.string().url().max(500).optional(),
          lines: z
            .array(
              z
                .object({
                  order_line_id: z.coerce.number().int().positive(),
                  quantity: z.coerce.number().int().min(1),
                })
                .strict(),
            )
            .min(1)
            .max(200),
        })
        .strict(),
      summary: "Create a shipment and mark the order shipped",
      tags: ["admin"],
    },
    async ({ ctx, body, tx }) => ({
      data: await createShipment(tx!, {
        adminUserId: ctx.actor!.kind === "admin" ? ctx.actor!.adminUserId : "",
        orderId: Number((ctx.req.params as any).orderId),
        carrier: body.carrier,
        trackingNumber: body.tracking_number,
        trackingUrl: body.tracking_url,
        lines: (
          body.lines as Array<{ order_line_id: number; quantity: number }>
        ).map((line) => ({
          orderLineId: line.order_line_id,
          quantity: line.quantity,
        })),
      }),
    }),
  );

  endpoint(
    router,
    "patch",
    "/admin/shipments/:shipmentId",
    {
      auth: "admin",
      permissions: ["shipments.write"],
      body: z
        .object({
          status: z.enum([
            "dispatched",
            "in_transit",
            "delivered",
            "failed",
            "returned",
          ]),
          tracking_url: z.string().url().max(500).optional(),
        })
        .strict(),
      summary: "Update shipment tracking status",
      tags: ["admin"],
    },
    async ({ ctx, body, tx }) => ({
      data: await updateShipmentStatus(tx!, {
        adminUserId: ctx.actor!.kind === "admin" ? ctx.actor!.adminUserId : "",
        shipmentId: String((ctx.req.params as any).shipmentId),
        status: body.status,
        trackingUrl: body.tracking_url,
      }),
    }),
  );

  endpoint(
    router,
    "post",
    "/admin/orders/:orderId/refunds",
    {
      auth: "admin",
      permissions: ["refunds.write"],
      transactional: false,
      status: 201,
      body: z
        .object({
          amount: moneyString,
          reason: z.string().trim().min(5).max(255),
          restock: z.boolean().default(false),
          transaction_id: z.uuid().optional(),
        })
        .strict(),
      summary: "Refund a captured payment (requires Idempotency-Key)",
      tags: ["admin"],
    },
    async ({ ctx, body }) => {
      const key = ctx.req.header("Idempotency-Key");
      if (!key)
        fail(
          422,
          "IDEMPOTENCY_REQUIRED",
          "Idempotency-Key header is required for refunds",
        );
      const orderId = Number((ctx.req.params as any).orderId);
      const refund = await requestRefund(ctx.db, {
        adminUserId: ctx.actor!.kind === "admin" ? ctx.actor!.adminUserId : "",
        orderId,
        transactionId: body.transaction_id,
        amount: body.amount,
        reason: body.reason,
        restock: body.restock,
        idempotencyKey: `admin-refund:${key}`.slice(0, 120),
      });
      return { data: refund };
    },
  );

  endpoint(
    router,
    "get",
    "/admin/payments/webhooks",
    {
      auth: "admin",
      permissions: ["payments.read"],
      query: pageQuery
        .extend({ status: z.string().max(20).optional() })
        .strict(),
      summary: "Inspect received provider webhooks",
      tags: ["admin"],
    },
    async ({ ctx, query }) => {
      const offset = (query.page - 1) * query.limit;
      const rows = await ctx.db.query<any>(
        `SELECT webhook_id, provider, event_id, event_type, signature_valid, status, attempts, error, received_at, processed_at,
                count(*) OVER()::int AS _count
           FROM payment_webhook
          WHERE ($1::text IS NULL OR status = $1)
          ORDER BY received_at DESC LIMIT $2 OFFSET $3`,
        [query.status ?? null, query.limit, offset],
      );
      return {
        data: {
          items: rows.rows.map(({ _count, ...row }) => row),
          page: query.page,
          limit: query.limit,
          total: rows.rows[0]?._count ?? 0,
        },
      };
    },
  );

  endpoint(
    router,
    "get",
    "/admin/sync/overview",
    {
      auth: "admin",
      permissions: ["sync.manage"],
      summary: "ERP sync job and log overview",
      tags: ["admin", "erp"],
    },
    async ({ ctx }) => ({
      data: {
        ...(await syncOverview(ctx.db)),
        capabilities: ERP_CAPABILITIES.map(
          ({ id, support, endpoint, contract }) => ({
            id,
            support,
            endpoint,
            contract,
          }),
        ),
      },
    }),
  );

  endpoint(
    router,
    "get",
    "/admin/erp/capabilities",
    {
      auth: "admin",
      permissions: ["sync.manage"],
      summary: "Verified vs missing ERP capabilities",
      tags: ["admin", "erp"],
    },
    async () => ({
      data: { enabled: erpEnabled(), capabilities: ERP_CAPABILITIES },
    }),
  );

  endpoint(
    router,
    "post",
    "/admin/erp/probe",
    {
      auth: "admin",
      permissions: ["sync.manage"],
      transactional: false,
      summary: "Probe ERP health, identity and permissions (read-only)",
      tags: ["admin", "erp"],
    },
    async () => {
      if (!erpEnabled()) return { data: { enabled: false, probed: false } };
      const probe = await getErpAdapter().probe();
      return { data: { enabled: true, probed: true, ...probe } };
    },
  );

  endpoint(
    router,
    "get",
    "/admin/erp/mappings",
    {
      auth: "admin",
      permissions: ["sync.manage"],
      query: pageQuery
        .extend({ entity_type: z.string().max(30).optional() })
        .strict(),
      summary: "Local ↔ ERP entity mappings",
      tags: ["admin", "erp"],
    },
    async ({ ctx, query }) => {
      const offset = (query.page - 1) * query.limit;
      const rows = await ctx.db.query<any>(
        `SELECT map_id, entity_type, local_id, erp_id, metadata, last_synced_at, count(*) OVER()::int AS _count
           FROM erp_entity_map
          WHERE ($1::text IS NULL OR entity_type = $1)
          ORDER BY last_synced_at DESC LIMIT $2 OFFSET $3`,
        [query.entity_type ?? null, query.limit, offset],
      );
      return {
        data: {
          items: rows.rows.map(({ _count, ...row }) => row),
          page: query.page,
          limit: query.limit,
          total: rows.rows[0]?._count ?? 0,
        },
      };
    },
  );

  endpoint(
    router,
    "post",
    "/admin/sync/pull-catalog",
    {
      auth: "admin",
      permissions: ["sync.manage"],
      transactional: false,
      summary: "Pull the ERP catalogue now (idempotent by nature)",
      tags: ["admin", "erp"],
    },
    async ({ ctx }) => {
      const adapter = getErpAdapter();
      const summary = await pullCatalog(ctx.db, adapter);
      await audit(ctx.db, {
        actorType: "admin",
        actorId: (ctx.actor as any).adminUserId,
        action: "erp.catalog_pulled",
        entityType: "erp_sync",
        after: summary,
      });
      return { data: summary };
    },
  );

  endpoint(
    router,
    "post",
    "/admin/sync/pull-inventory",
    {
      auth: "admin",
      permissions: ["sync.manage"],
      transactional: false,
      summary: "Pull ERP stock balances now",
      tags: ["admin", "erp"],
    },
    async ({ ctx }) => {
      const adapter = getErpAdapter();
      const summary = await pullInventory(ctx.db, adapter);
      await audit(ctx.db, {
        actorType: "admin",
        actorId: (ctx.actor as any).adminUserId,
        action: "erp.inventory_pulled",
        entityType: "erp_sync",
        after: summary,
      });
      return { data: summary };
    },
  );

  endpoint(
    router,
    "post",
    "/admin/sync/process",
    {
      auth: "admin",
      permissions: ["sync.manage"],
      transactional: false,
      body: z
        .object({ max: z.coerce.number().int().min(1).max(50).default(10) })
        .strict(),
      summary: "Process due ERP sync jobs now (worker also runs these)",
      tags: ["admin", "erp"],
    },
    async ({ ctx, body }) => ({
      data: {
        processed: await processSyncJobs(ctx.db, getErpAdapter(), body.max),
      },
    }),
  );

  endpoint(
    router,
    "post",
    "/admin/sync/orders/:orderId",
    {
      auth: "admin",
      permissions: ["sync.manage"],
      transactional: false,
      summary: "Push one order to the ERP now",
      tags: ["admin", "erp"],
    },
    async ({ ctx }) => {
      const orderId = Number((ctx.req.params as any).orderId);
      return {
        data: await pushOrderDocument(ctx.db, getErpAdapter(), orderId),
      };
    },
  );

  endpoint(
    router,
    "post",
    "/admin/sync/customers/:customerId",
    {
      auth: "admin",
      permissions: ["sync.manage"],
      transactional: false,
      summary: "Map and push one customer to the ERP",
      tags: ["admin", "erp"],
    },
    async ({ ctx }) => ({
      data: await pushCustomer(
        ctx.db,
        getErpAdapter(),
        Number((ctx.req.params as any).customerId),
      ),
    }),
  );

  endpoint(
    router,
    "post",
    "/admin/erp/queue-catalog-pull",
    {
      auth: "admin",
      permissions: ["sync.manage"],
      transactional: false,
      summary: "Enqueue a catalogue pull for the worker",
      tags: ["admin", "erp"],
    },
    async ({ ctx }) => {
      const bucket = Math.floor(Date.now() / 60_000);
      return {
        data: await enqueueSyncJob(ctx.db, {
          entityType: "product",
          direction: "pull",
          operation: "pull_catalog",
          localId: `manual-${bucket}`,
          idempotencyKey: `ecommerce:manual-catalog:${bucket}`,
          payload: {},
          maxAttempts: 3,
        }),
      };
    },
  );

  endpoint(
    router,
    "get",
    "/admin/audit-logs",
    {
      auth: "admin",
      permissions: ["audit.read"],
      query: pageQuery
        .extend({
          entity_type: z.string().max(40).optional(),
          action: z.string().max(80).optional(),
        })
        .strict(),
      summary: "Audit trail",
      tags: ["admin"],
    },
    async ({ ctx, query }) => {
      const offset = (query.page - 1) * query.limit;
      const rows = await ctx.db.query<any>(
        `SELECT audit_id, actor_type, actor_id, action, entity_type, entity_id, before, after, request_id, created_at,
                count(*) OVER()::int AS _count
           FROM audit_log
          WHERE ($1::text IS NULL OR entity_type = $1) AND ($2::text IS NULL OR action = $2)
          ORDER BY audit_id DESC LIMIT $3 OFFSET $4`,
        [query.entity_type ?? null, query.action ?? null, query.limit, offset],
      );
      return {
        data: {
          items: rows.rows.map(({ _count, ...row }) => row),
          page: query.page,
          limit: query.limit,
          total: rows.rows[0]?._count ?? 0,
        },
      };
    },
  );

  endpoint(
    router,
    "get",
    "/admin/customers",
    {
      auth: "admin",
      permissions: ["customers.read"],
      query: pageQuery.extend({ q: z.string().max(120).optional() }).strict(),
      summary: "Search registered customers",
      tags: ["admin"],
    },
    async ({ ctx, query }) => {
      const offset = (query.page - 1) * query.limit;
      const search = `%${(query.q ?? "").trim()}%`;
      const rows = await ctx.db.query<any>(
        `SELECT c.customer_id, c.email, c.first_name, c.last_name, c.phone, c.status, c.created_at, c.last_login_at,
                (SELECT count(*) FROM customer_order o WHERE o.customer_id = c.customer_id)::int AS orders,
                (SELECT erp_id FROM erp_entity_map m WHERE m.entity_type='customer' AND m.local_id = c.customer_id::text) AS erp_customer_id,
                count(*) OVER()::int AS _count
           FROM customer c
          WHERE ($1 = '%%' OR c.email ILIKE $1 OR c.first_name ILIKE $1 OR c.last_name ILIKE $1)
          ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
        [search, query.limit, offset],
      );
      return {
        data: {
          items: rows.rows.map(({ _count, ...row }) => row),
          page: query.page,
          limit: query.limit,
          total: rows.rows[0]?._count ?? 0,
        },
      };
    },
  );

  endpoint(
    router,
    "get",
    "/admin/products",
    {
      auth: "admin",
      permissions: ["catalog.read"],
      query: pageQuery
        .extend({
          q: z.string().max(120).optional(),
          status: z.enum(["draft", "active", "archived"]).optional(),
        })
        .strict(),
      summary: "Catalogue with sync state",
      tags: ["admin"],
    },
    async ({ ctx, query }) => {
      const offset = (query.page - 1) * query.limit;
      const search = `%${(query.q ?? "").trim()}%`;
      const rows = await ctx.db.query<any>(
        `SELECT p.product_id, p.product_name, p.slug, p.status, p.is_featured, p.sync_state, p.erp_updated_at, p.updated_at,
                (SELECT count(*) FROM product_variant v WHERE v.product_id = p.product_id)::int AS variants,
                (SELECT count(*) FROM product_variant v WHERE v.product_id = p.product_id AND v.is_active)::int AS active_variants,
                (SELECT c.category_name FROM product_category pc JOIN category c ON c.category_id = pc.category_id
                  WHERE pc.product_id = p.product_id ORDER BY pc.category_id LIMIT 1) AS category_name,
                (SELECT erp_id FROM erp_entity_map m WHERE m.entity_type='product' AND m.local_id = p.product_id::text) AS erp_product_id,
                count(*) OVER()::int AS _count
           FROM product p
          WHERE ($1 = '%%' OR p.product_name ILIKE $1) AND ($2::text IS NULL OR p.status = $2)
          ORDER BY p.updated_at DESC LIMIT $3 OFFSET $4`,
        [search, query.status ?? null, query.limit, offset],
      );
      return {
        data: {
          items: rows.rows.map(({ _count, ...row }) => row),
          page: query.page,
          limit: query.limit,
          total: rows.rows[0]?._count ?? 0,
        },
      };
    },
  );

  endpoint(
    router,
    "patch",
    "/admin/products/:productId/status",
    {
      auth: "admin",
      permissions: ["catalog.write"],
      body: z
        .object({ status: z.enum(["draft", "active", "archived"]) })
        .strict(),
      summary:
        "Publish or archive a product locally (ERP stays the stock/price master)",
      tags: ["admin"],
    },
    async ({ ctx, body, tx }) => {
      const productId = Number((ctx.req.params as any).productId);
      const updated = await tx!.query<any>(
        "UPDATE product SET status = $2, updated_at = now() WHERE product_id = $1 RETURNING product_id, status",
        [productId, body.status],
      );
      if (!updated.rows[0]) fail(404, "NOT_FOUND", "Product not found");
      await audit(tx!, {
        actorType: "admin",
        actorId: (ctx.actor as any).adminUserId,
        action: "catalog.status_changed",
        entityType: "product",
        entityId: productId,
        after: { status: body.status },
      });
      return { data: updated.rows[0] };
    },
  );

  endpoint(
    router,
    "patch",
    "/admin/reviews/:reviewId",
    {
      auth: "admin",
      permissions: ["catalog.write"],
      body: z
        .object({ status: z.enum(["pending", "published", "rejected"]) })
        .strict(),
      summary: "Moderate a review",
      tags: ["admin"],
    },
    async ({ ctx, body, tx }) => {
      const reviewId = Number((ctx.req.params as any).reviewId);
      const updated = await tx!.query<any>(
        `UPDATE review SET status = $2, published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END
          WHERE review_id = $1 RETURNING review_id, status, published_at`,
        [reviewId, body.status],
      );
      if (!updated.rows[0]) fail(404, "NOT_FOUND", "Review not found");
      await audit(tx!, {
        actorType: "admin",
        actorId: (ctx.actor as any).adminUserId,
        action: "review.moderated",
        entityType: "review",
        entityId: reviewId,
        after: { status: body.status },
      });
      return { data: updated.rows[0] };
    },
  );

  // ------------------------------------------------------------------ catalogue
  // Products and variants. The ERP owns price and stock for the products it
  // mirrors, so these write the local merchandising layer only: what exists,
  // what it costs on this storefront, and what is published.

  const optionBody = z
    .object({
      option: z.string().trim().min(1).max(50),
      value: z.string().trim().min(1).max(50),
    })
    .strict();

  const variantBody = z
    .object({
      sku: z.string().trim().min(1).max(50),
      price: moneyString,
      qty_in_stock: nonNegativeInt,
      compare_at_price: moneyString.optional(),
      barcode: z.string().trim().max(64).optional(),
      weight_grams: nonNegativeInt.optional(),
      is_active: z.boolean().optional(),
      is_default: z.boolean().optional(),
      options: z.array(optionBody).max(6).optional(),
    })
    .strict();

  // A variant patch may also *clear* the optional fields, so they accept null.
  const variantPatch = variantBody.partial().extend({
    compare_at_price: moneyString.nullish(),
    barcode: z.string().trim().max(64).nullish(),
    weight_grams: nonNegativeInt.nullish(),
  });

  const productBody = z
    .object({
      product_name: z.string().trim().min(2).max(255),
      slug: z.string().trim().max(180).optional(),
      summary: z.string().trim().max(400).optional(),
      description: z.string().trim().max(5000).optional(),
      status: z.enum(["draft", "active", "archived"]).optional(),
      is_featured: z.boolean().optional(),
      category_id: z.coerce.number().int().positive().nullish(),
      brand_name: z.string().trim().max(100).nullish(),
      variants: z.array(variantBody).max(50).optional(),
    })
    .strict();

  endpoint(
    router,
    "post",
    "/admin/products",
    {
      auth: "admin",
      permissions: ["catalog.write"],
      status: 201,
      body: productBody,
      summary: "Create a product locally with optional variants",
      tags: ["admin"],
    },
    async ({ ctx, body, tx }) => {
      const product = await createProduct(tx!, {
        ...body,
        summary: body.summary || undefined,
        description: body.description || undefined,
      });
      await audit(tx!, {
        actorType: "admin",
        actorId: (ctx.actor as any).adminUserId,
        action: "catalog.product_created",
        entityType: "product",
        entityId: product.product_id,
        after: {
          product_name: product.product_name,
          status: product.status,
          variants: product.variants.length,
        },
      });
      return { data: { product } };
    },
  );

  endpoint(
    router,
    "get",
    "/admin/products/:productId",
    {
      auth: "admin",
      permissions: ["catalog.read"],
      summary: "One product with its variants, options and images",
      tags: ["admin"],
    },
    async ({ ctx }) => {
      const productId = Number((ctx.req.params as any).productId);
      if (!Number.isInteger(productId) || productId <= 0)
        fail(404, "NOT_FOUND", "Product not found");
      return { data: { product: await getAdminProduct(ctx.db, productId) } };
    },
  );

  endpoint(
    router,
    "patch",
    "/admin/products/:productId",
    {
      auth: "admin",
      permissions: ["catalog.write"],
      body: productBody.partial(),
      summary:
        "Edit a product's merchandising fields, publish state or feature flag",
      tags: ["admin"],
    },
    async ({ ctx, body, tx }) => {
      const productId = Number((ctx.req.params as any).productId);
      if (!Number.isInteger(productId) || productId <= 0)
        fail(404, "NOT_FOUND", "Product not found");
      const product = await updateProduct(tx!, productId, {
        ...body,
        summary: body.summary === undefined ? undefined : body.summary,
        description:
          body.description === undefined ? undefined : body.description,
      });
      await audit(tx!, {
        actorType: "admin",
        actorId: (ctx.actor as any).adminUserId,
        action: "catalog.product_updated",
        entityType: "product",
        entityId: productId,
        after: {
          status: product.status,
          is_featured: product.is_featured,
          product_name: product.product_name,
        },
      });
      return { data: { product } };
    },
  );

  endpoint(
    router,
    "put",
    "/admin/products/:productId/image",
    {
      auth: "admin",
      permissions: ["catalog.write"],
      body: z
        .object({
          image_url: z
            .string()
            .trim()
            .max(500)
            .nullable()
            .refine(
              (value) =>
                value === null ||
                value === "" ||
                /^https?:\/\/[^\s]+$/i.test(value) ||
                /^\/(?!\/)[^\s]*$/.test(value),
              "Use an https URL or a path this site serves",
            ),
        })
        .strict(),
      summary: "Set or clear a product's primary image (an https URL or the ERP proxy path)",
      tags: ["admin"],
    },
    async ({ ctx, body, tx }) => {
      const productId = Number((ctx.req.params as any).productId);
      if (!Number.isInteger(productId) || productId <= 0) fail(404, "NOT_FOUND", "Product not found");
      const product = await setProductImage(tx!, productId, body.image_url || null);
      await audit(tx!, {
        actorType: "admin",
        actorId: (ctx.actor as any).adminUserId,
        action: "catalog.image_changed",
        entityType: "product",
        entityId: productId,
        after: { image_url: body.image_url || null },
      });
      return { data: { product } };
    },
  );

  endpoint(
    router,
    "post",
    "/admin/products/:productId/variants",
    {
      auth: "admin",
      permissions: ["catalog.write"],
      status: 201,
      body: variantBody,
      summary: "Add a variant (SKU, price, stock, options) to a product",
      tags: ["admin"],
    },
    async ({ ctx, body, tx }) => {
      const productId = Number((ctx.req.params as any).productId);
      if (!Number.isInteger(productId) || productId <= 0)
        fail(404, "NOT_FOUND", "Product not found");
      const variant = await insertVariant(tx!, productId, body);
      await audit(tx!, {
        actorType: "admin",
        actorId: (ctx.actor as any).adminUserId,
        action: "catalog.variant_created",
        entityType: "product_variant",
        entityId: variant.variant_id,
        after: {
          sku: variant.sku,
          price: variant.price,
          qty_in_stock: variant.qty_in_stock,
        },
      });
      return { data: { variant } };
    },
  );

  endpoint(
    router,
    "patch",
    "/admin/variants/:variantId",
    {
      auth: "admin",
      permissions: ["catalog.write"],
      body: variantPatch,
      summary:
        "Edit a variant, or take it off the storefront with is_active: false",
      tags: ["admin"],
    },
    async ({ ctx, body, tx }) => {
      const variantId = Number((ctx.req.params as any).variantId);
      if (!Number.isInteger(variantId) || variantId <= 0)
        fail(404, "NOT_FOUND", "Variant not found");
      const variant = await updateVariant(tx!, variantId, body);
      await audit(tx!, {
        actorType: "admin",
        actorId: (ctx.actor as any).adminUserId,
        action: "catalog.variant_updated",
        entityType: "product_variant",
        entityId: variantId,
        after: {
          sku: variant.sku,
          price: variant.price,
          qty_in_stock: variant.qty_in_stock,
          is_active: variant.is_active,
        },
      });
      return { data: { variant } };
    },
  );

  endpoint(
    router,
    "get",
    "/admin/settings",
    {
      auth: "admin",
      permissions: ["settings.manage"],
      summary: "Store, payment and ERP settings (no secrets)",
      tags: ["admin"],
    },
    async ({ ctx }) => {
      const rows = await ctx.db.query<any>(
        "SELECT key, value, updated_at FROM app_setting ORDER BY key",
      );
      return {
        data: {
          settings: Object.fromEntries(
            rows.rows.map((row) => [row.key, row.value]),
          ),
          erp: {
            enabled: erpEnabled(),
            capabilities_verified: ERP_CAPABILITIES.filter(
              (c) => c.support === "verified",
            ).length,
            capabilities_missing: ERP_CAPABILITIES.filter(
              (c) => c.support === "unsupported",
            ).length,
          },
        },
      };
    },
  );

  endpoint(
    router,
    "put",
    "/admin/settings/store",
    {
      auth: "admin",
      permissions: ["settings.manage"],
      body: z
        .object({
          name: z.string().trim().min(1).max(120),
          support_email: z.email().max(255).optional(),
          allow_guest_checkout: z.boolean().optional(),
          require_phone: z.boolean().optional(),
        })
        .strict(),
      summary: "Update storefront settings",
      tags: ["admin"],
    },
    async ({ ctx, body, tx }) => {
      const current = await tx!.query<any>(
        "SELECT value FROM app_setting WHERE key = 'store'",
      );
      const store = { ...(current.rows[0]?.value ?? {}), name: body.name };
      if (body.support_email !== undefined)
        store.support_email = body.support_email;
      await tx!.query(
        `INSERT INTO app_setting(key, value) VALUES('store', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(store)],
      );
      await audit(tx!, {
        actorType: "admin",
        actorId: (ctx.actor as any).adminUserId,
        action: "settings.store_updated",
        entityType: "app_setting",
        entityId: "store",
        after: store,
      });
      return { data: { store, slug: slugify(body.name) } };
    },
  );
}
