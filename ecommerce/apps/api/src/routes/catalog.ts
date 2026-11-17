import { Router } from "express";
import { z } from "zod";
import { endpoint } from "../http/route.ts";
import {
  getProduct,
  listBrands,
  listCategories,
  listProducts,
} from "../services/catalog.ts";
import {
  reviewSchema,
  createReview,
  listPublishedReviews,
} from "../services/reviews.ts";

const listQuery = z
  .object({
    q: z.string().trim().max(120).optional(),
    category: z.string().trim().max(140).optional(),
    brand: z.string().trim().max(140).optional(),
    featured: z.enum(["true", "false"]).optional(),
    sort: z.enum(["newest", "price_asc", "price_desc", "name"]).optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(48).default(24),
  })
  .strict();

export function registerCatalogRoutes(router: Router) {
  endpoint(
    router,
    "get",
    "/catalog/products",
    {
      query: listQuery,
      summary: "Browse published products with live availability",
      tags: ["catalog"],
    },
    async ({ ctx, query }) => ({
      data: await listProducts(ctx.db, {
        q: query.q,
        category: query.category,
        brand: query.brand,
        featured: query.featured === "true",
        page: query.page,
        limit: query.limit,
        sort: query.sort,
      }),
    }),
  );

  endpoint(
    router,
    "get",
    "/catalog/products/:slug",
    { summary: "Product detail by slug or numeric id", tags: ["catalog"] },
    async ({ ctx }) => ({
      data: await getProduct(ctx.db, String((ctx.req.params as any).slug)),
    }),
  );

  endpoint(
    router,
    "get",
    "/catalog/products/:slug/reviews",
    {
      query: z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(50).default(10),
        })
        .strict(),
      summary: "Published reviews for a product",
      tags: ["catalog"],
    },
    async ({ ctx, query }) => ({
      data: await listPublishedReviews(ctx.db, {
        slugOrId: String((ctx.req.params as any).slug),
        page: query.page,
        limit: query.limit,
      }),
    }),
  );

  endpoint(
    router,
    "get",
    "/catalog/categories",
    { summary: "Active categories with product counts", tags: ["catalog"] },
    async ({ ctx }) => ({ data: { items: await listCategories(ctx.db) } }),
  );

  endpoint(
    router,
    "get",
    "/catalog/brands",
    { summary: "Active brands", tags: ["catalog"] },
    async ({ ctx }) => ({ data: { items: await listBrands(ctx.db) } }),
  );

  // Delivery options are store configuration, not catalogue content, but they
  // are public in the same way: the checkout needs the real names and fees the
  // ERP-side shipping_method table holds, instead of a copy in the browser.
  endpoint(
    router,
    "get",
    "/catalog/shipping-methods",
    {
      summary: "Active delivery options with their fees and estimates",
      tags: ["catalog"],
    },
    async ({ ctx }) => ({
      data: {
        items: (
          await ctx.db.query(
            `SELECT shipping_method_id, method_name, price::text AS price, code, min_days, max_days
               FROM shipping_method WHERE is_active ORDER BY shipping_method_id`,
          )
        ).rows,
      },
    }),
  );

  endpoint(
    router,
    "post",
    "/reviews",
    {
      auth: "customer",
      status: 201,
      body: reviewSchema,
      summary: "Review a purchased item (one review per order line)",
      tags: ["reviews"],
    },
    async ({ ctx, body, tx }) => ({
      data: await createReview(tx!, {
        customerId: (ctx.actor as any).customerId,
        orderLineId: body.order_line_id,
        rating: body.rating,
        title: body.title,
        comment: body.comment,
      }),
    }),
  );
}
