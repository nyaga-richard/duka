/** Product reviews: only a delivered/paid purchase can be reviewed, once. */
import { z } from "zod";
import type { Queryable } from "../db/index.ts";
import { fail } from "../errors.ts";
import { audit } from "./security.ts";

export const reviewSchema = z
  .object({
    order_line_id: z.coerce.number().int().positive(),
    rating: z.coerce.number().int().min(1).max(5),
    title: z.string().trim().max(160).optional(),
    comment: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function createReview(
  tx: Queryable,
  input: { customerId: number; orderLineId: number; rating: number; title?: string; comment?: string },
) {
  const lines = await tx.query<any>(
    `SELECT l.order_line_id, l.product_id, o.customer_id, o.order_status_id
       FROM order_line l JOIN customer_order o ON o.order_id = l.order_id
      WHERE l.order_line_id = $1`,
    [input.orderLineId],
  );
  const line = lines.rows[0];
  if (!line || line.customer_id !== input.customerId) {
    fail(404, "NOT_FOUND", "Purchase not found");
  }
  if (![3, 4, 5, 6].includes(line.order_status_id)) {
    fail(409, "CONFLICT", "Only paid or delivered purchases can be reviewed");
  }
  const existing = await tx.query("SELECT 1 FROM review WHERE order_line_id = $1", [input.orderLineId]);
  if (existing.rowCount > 0) fail(409, "CONFLICT", "This purchase has already been reviewed");

  const review = await tx.query<any>(
    `INSERT INTO review(order_line_id, customer_id, rating, title, comment, status)
     VALUES($1,$2,$3,$4,$5,'pending')
     RETURNING review_id, rating, title, comment, status, created_at`,
    [input.orderLineId, input.customerId, input.rating, input.title ?? null, input.comment ?? null],
  );
  await audit(tx, {
    actorType: "customer",
    actorId: String(input.customerId),
    action: "review.created",
    entityType: "review",
    entityId: review.rows[0]!.review_id,
    after: { rating: input.rating, order_line_id: input.orderLineId },
  });
  return review.rows[0];
}

export async function listPublishedReviews(db: Queryable, input: { slugOrId: string; page: number; limit: number }) {
  const isNumeric = /^\d+$/.test(input.slugOrId);
  const products = await db.query<{ product_id: number }>(
    `SELECT product_id FROM product WHERE (($1::boolean AND product_id = $2::int) OR (NOT $1::boolean AND slug = $3)) LIMIT 1`,
    [isNumeric, isNumeric ? Number(input.slugOrId) : 0, input.slugOrId],
  );
  if (!products.rows[0]) fail(404, "NOT_FOUND", "Product not found");
  const offset = (input.page - 1) * input.limit;
  const rows = await db.query<any>(
    `SELECT r.review_id, r.rating, r.title, r.comment, r.created_at,
            c.first_name, left(c.last_name, 1) AS last_initial,
            count(*) OVER()::int AS _count
       FROM review r
       JOIN order_line l ON l.order_line_id = r.order_line_id
       JOIN customer c ON c.customer_id = r.customer_id
      WHERE l.product_id = $1 AND r.status = 'published'
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3`,
    [products.rows[0].product_id, input.limit, offset],
  );
  const total = rows.rows[0]?._count ?? 0;
  const average = await db.query<{ average: string | null }>(
    `SELECT round(avg(r.rating)::numeric, 2)::text AS average
       FROM review r JOIN order_line l ON l.order_line_id = r.order_line_id
      WHERE l.product_id = $1 AND r.status = 'published'`,
    [products.rows[0].product_id],
  );
  return {
    items: rows.rows.map(({ _count, ...row }) => row),
    page: input.page,
    limit: input.limit,
    total,
    average_rating: average.rows[0]?.average ?? null,
  };
}
