/**
 * Storefront catalogue.
 *
 * Only locally mirrored, published data is exposed publicly. Variant prices and
 * stock come from the ERP mirror (`sync`), never from client input.
 */
import type { Queryable } from "../db/index.ts";
import { fail } from "../errors.ts";
import { toMoney } from "@ecom/shared";

const VARIANT_SELECT = `
  SELECT v.variant_id, v.sku, v.price::text AS price, v.compare_at_price::text AS compare_at_price,
         v.qty_in_stock, v.is_default, v.is_active, v.barcode, v.weight_grams,
         coalesce((
           SELECT sum(r.quantity) FROM inventory_reservation r
            WHERE r.variant_id = v.variant_id AND r.status = 'active' AND r.expires_at > now()
         ), 0)::int AS reserved,
         greatest(v.qty_in_stock - coalesce((
           SELECT sum(r.quantity) FROM inventory_reservation r
            WHERE r.variant_id = v.variant_id AND r.status = 'active' AND r.expires_at > now()
         ), 0), 0)::int AS available,
         coalesce((
           SELECT json_agg(json_build_object('option', o.option_name, 'value', ov.value_name)
                           ORDER BY o.sort_order, ov.sort_order)
             FROM variant_option_value vov
             JOIN product_option o ON o.option_id = vov.option_id
             JOIN product_option_value ov ON ov.option_value_id = vov.option_value_id
            WHERE vov.variant_id = v.variant_id
         ), '[]'::json) AS options
    FROM product_variant v
   WHERE v.product_id = p.product_id
   ORDER BY v.is_default DESC, v.variant_id`;

const PRODUCT_COLUMNS = `
  p.product_id, p.product_name, p.slug, p.summary, p.description, p.status, p.is_featured,
  p.seo_title, p.seo_description, p.created_at, p.updated_at,
  b.brand_name, c.category_name, c.slug AS category_slug`;

export interface ProductListQuery {
  q?: string;
  category?: string;
  brand?: string;
  featured?: boolean;
  page: number;
  limit: number;
  sort?: "newest" | "price_asc" | "price_desc" | "name";
}

function mapProduct(row: any) {
  const variants = (row.variants ?? []).map((variant: any) => ({
    variant_id: variant.variant_id,
    sku: variant.sku,
    price: toMoney(variant.price),
    compare_at_price: variant.compare_at_price
      ? toMoney(variant.compare_at_price)
      : null,
    available: variant.available,
    in_stock: variant.available > 0,
    is_default: variant.is_default,
    options: variant.options ?? [],
  }));
  return {
    product_id: row.product_id,
    name: row.product_name,
    slug: row.slug,
    summary: row.summary,
    description: row.description,
    brand: row.brand_name,
    category: row.category_name,
    category_slug: row.category_slug,
    featured: row.is_featured,
    seo: { title: row.seo_title, description: row.seo_description },
    images: row.images ?? [],
    attributes: row.attributes ?? [],
    variants,
    price_from: variants.length
      ? variants.reduce(
          (min: string, v: any) =>
            Number(v.price) < Number(min) ? v.price : min,
          variants[0].price,
        )
      : null,
    in_stock: variants.some((v: any) => v.in_stock),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listProducts(db: Queryable, query: ProductListQuery) {
  const offset = (query.page - 1) * query.limit;
  const search = `%${(query.q ?? "").trim().slice(0, 120)}%`;
  const rows = await db.query<any>(
    `SELECT ${PRODUCT_COLUMNS},
            (SELECT json_agg(json_build_object(
                       'variant_id', v.variant_id, 'sku', v.sku, 'price', v.price::text,
                       'compare_at_price', v.compare_at_price::text, 'is_default', v.is_default,
                       'qty_in_stock', v.qty_in_stock,
                       'reserved', coalesce((SELECT sum(r.quantity) FROM inventory_reservation r
                                              WHERE r.variant_id = v.variant_id AND r.status='active' AND r.expires_at > now()),0)::int,
                       'available', greatest(v.qty_in_stock - coalesce((SELECT sum(r.quantity) FROM inventory_reservation r
                                              WHERE r.variant_id = v.variant_id AND r.status='active' AND r.expires_at > now()),0),0)::int,
                       'options', coalesce((SELECT json_agg(json_build_object('option', o.option_name, 'value', ov.value_name)
                                                            ORDER BY o.sort_order, ov.sort_order)
                                              FROM variant_option_value vov
                                              JOIN product_option o ON o.option_id = vov.option_id
                                              JOIN product_option_value ov ON ov.option_value_id = vov.option_value_id
                                             WHERE vov.variant_id = v.variant_id), '[]'::json))
                    ORDER BY v.is_default DESC, v.variant_id)
              FROM product_variant v
             WHERE v.product_id = p.product_id AND v.is_active) AS variants,
            (SELECT json_agg(json_build_object('url', i.image_url, 'alt', i.alt_text, 'is_primary', i.is_primary)
                             ORDER BY i.is_primary DESC, i.sort_order)
               FROM product_image i WHERE i.product_id = p.product_id) AS images,
            (SELECT json_agg(json_build_object('key', a.attribute_key, 'label', a.attribute_label, 'value', aa.value_text)
                             ORDER BY a.sort_order)
               FROM product_attribute_assignment aa
               JOIN product_attribute a ON a.attribute_id = aa.attribute_id
              WHERE aa.product_id = p.product_id) AS attributes,
            count(*) OVER()::int AS _count
       FROM product p
       LEFT JOIN brand b ON b.brand_id = p.brand_id
       LEFT JOIN category c ON c.category_id = (
         SELECT pc.category_id FROM product_category pc WHERE pc.product_id = p.product_id ORDER BY pc.category_id LIMIT 1)
      WHERE p.status = 'active'
        AND ($1 = '%%' OR p.product_name ILIKE $1 OR coalesce(p.summary, '') ILIKE $1 OR coalesce(p.brand, '') ILIKE $1
             OR EXISTS (SELECT 1 FROM product_variant v WHERE v.product_id = p.product_id AND v.sku ILIKE $1))
        AND ($2::text IS NULL OR c.slug = $2)
        AND ($3::text IS NULL OR b.slug = $3)
        AND ($4::boolean = false OR p.is_featured)
      ORDER BY
        CASE WHEN $5 = 'price_asc' THEN (SELECT min(v.price) FROM product_variant v WHERE v.product_id = p.product_id) END ASC,
        CASE WHEN $5 = 'price_desc' THEN (SELECT min(v.price) FROM product_variant v WHERE v.product_id = p.product_id) END DESC,
        CASE WHEN $5 = 'name' THEN p.product_name END ASC,
        p.created_at DESC
      LIMIT $6 OFFSET $7`,
    [
      search,
      query.category ?? null,
      query.brand ?? null,
      query.featured ?? false,
      query.sort ?? "newest",
      query.limit,
      offset,
    ],
  );
  const total = rows.rows[0]?._count ?? 0;
  return {
    items: rows.rows.map(mapProduct),
    page: query.page,
    limit: query.limit,
    total,
    pages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export async function getProduct(db: Queryable, slugOrId: string) {
  const isNumeric = /^\d+$/.test(slugOrId);
  const rows = await db.query<any>(
    `SELECT ${PRODUCT_COLUMNS},
            (SELECT json_agg(json_build_object(
                       'variant_id', v.variant_id, 'sku', v.sku, 'price', v.price::text,
                       'compare_at_price', v.compare_at_price::text, 'is_default', v.is_default,
                       'qty_in_stock', v.qty_in_stock,
                       'reserved', coalesce((SELECT sum(r.quantity) FROM inventory_reservation r
                                              WHERE r.variant_id = v.variant_id AND r.status='active' AND r.expires_at > now()),0)::int,
                       'available', greatest(v.qty_in_stock - coalesce((SELECT sum(r.quantity) FROM inventory_reservation r
                                              WHERE r.variant_id = v.variant_id AND r.status='active' AND r.expires_at > now()),0),0)::int,
                       'options', coalesce((SELECT json_agg(json_build_object('option', o.option_name, 'value', ov.value_name)
                                                            ORDER BY o.sort_order, ov.sort_order)
                                              FROM variant_option_value vov
                                              JOIN product_option o ON o.option_id = vov.option_id
                                              JOIN product_option_value ov ON ov.option_value_id = vov.option_value_id
                                             WHERE vov.variant_id = v.variant_id), '[]'::json))
                    ORDER BY v.is_default DESC, v.variant_id)
              FROM product_variant v
             WHERE v.product_id = p.product_id AND v.is_active) AS variants,
            (SELECT json_agg(json_build_object('url', i.image_url, 'alt', i.alt_text, 'is_primary', i.is_primary)
                             ORDER BY i.is_primary DESC, i.sort_order)
               FROM product_image i WHERE i.product_id = p.product_id) AS images,
            (SELECT json_agg(json_build_object('key', a.attribute_key, 'label', a.attribute_label, 'value', aa.value_text)
                             ORDER BY a.sort_order)
               FROM product_attribute_assignment aa
               JOIN product_attribute a ON a.attribute_id = aa.attribute_id
              WHERE aa.product_id = p.product_id) AS attributes,
            (SELECT json_agg(json_build_object('option_id', o.option_id, 'name', o.option_name,
                                               'values', (SELECT json_agg(json_build_object('id', ov.option_value_id, 'value', ov.value_name) ORDER BY ov.sort_order)
                                                            FROM product_option_value ov WHERE ov.option_id = o.option_id))
                             ORDER BY o.sort_order)
               FROM product_option o WHERE o.product_id = p.product_id) AS option_groups
       FROM product p
       LEFT JOIN brand b ON b.brand_id = p.brand_id
       LEFT JOIN category c ON c.category_id = (
         SELECT pc.category_id FROM product_category pc WHERE pc.product_id = p.product_id ORDER BY pc.category_id LIMIT 1)
      WHERE p.status = 'active'
        AND (($1::boolean AND p.product_id = $2::int) OR (NOT $1::boolean AND p.slug = $3))
      LIMIT 1`,
    [isNumeric, isNumeric ? Number(slugOrId) : 0, slugOrId],
  );
  const row = rows.rows[0];
  if (!row) fail(404, "NOT_FOUND", "Product not found");
  return { ...mapProduct(row), option_groups: row.option_groups ?? [] };
}

export async function listCategories(db: Queryable) {
  const rows = await db.query<any>(
    `SELECT c.category_id, c.category_name, c.slug, c.parent_category_id, c.image_url,
            (SELECT count(*) FROM product_category pc
               JOIN product p ON p.product_id = pc.product_id AND p.status = 'active'
              WHERE pc.category_id = c.category_id)::int AS product_count
       FROM category c
      WHERE c.is_active
      ORDER BY c.sort_order, c.category_name`,
  );
  return rows.rows;
}

export async function listBrands(db: Queryable) {
  const rows = await db.query<any>(
    `SELECT b.brand_id, b.brand_name, b.slug, b.logo_url,
            (SELECT count(*) FROM product p WHERE p.brand_id = b.brand_id AND p.status = 'active')::int AS product_count
       FROM brand b WHERE b.is_active ORDER BY b.brand_name`,
  );
  return rows.rows;
}
