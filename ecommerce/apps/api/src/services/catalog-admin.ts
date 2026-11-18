/**
 * Catalogue administration: products and their variants.
 *
 * The ERP remains the price and stock master for products it owns, so nothing
 * here writes back to it. What this module owns is the local merchandising
 * layer the storefront actually reads: the product record, whether it is
 * published, whether it is featured on the landing page, and its variants —
 * created by hand for products the shop carries outside the ERP, or adjusted
 * (price, stock on hand, active) for ones the ERP mirrored.
 */
import { fail } from "../errors.ts";
import type { Queryable } from "../db/index.ts";
import { slugify, toMoney } from "@ecom/shared";

const ADMIN_VARIANT_SELECT = `
  SELECT v.variant_id, v.product_id, v.sku, v.price::text AS price,
         v.compare_at_price::text AS compare_at_price, v.qty_in_stock, v.barcode,
         v.weight_grams, v.is_default, v.is_active, v.updated_at,
         coalesce((SELECT sum(r.quantity) FROM inventory_reservation r
                    WHERE r.variant_id = v.variant_id AND r.status = 'active' AND r.expires_at > now()), 0)::int AS reserved,
         greatest(v.qty_in_stock - coalesce((SELECT sum(r.quantity) FROM inventory_reservation r
                    WHERE r.variant_id = v.variant_id AND r.status = 'active' AND r.expires_at > now()), 0), 0)::int AS available,
         coalesce((SELECT json_agg(json_build_object('option', o.option_name, 'value', ov.value_name)
                                   ORDER BY o.sort_order, ov.sort_order)
                     FROM variant_option_value vov
                     JOIN product_option o ON o.option_id = vov.option_id
                     JOIN product_option_value ov ON ov.option_value_id = vov.option_value_id
                    WHERE vov.variant_id = v.variant_id), '[]'::json) AS options
    FROM product_variant v`;

export interface VariantInput {
  sku: string;
  price: string;
  qty_in_stock: number;
  compare_at_price?: string | null;
  barcode?: string | null;
  weight_grams?: number | null;
  is_active?: boolean;
  is_default?: boolean;
  options?: Array<{ option: string; value: string }>;
}

export interface ProductInput {
  product_name: string;
  slug?: string;
  summary?: string;
  description?: string;
  status?: "draft" | "active" | "archived";
  is_featured?: boolean;
  category_id?: number | null;
  brand_name?: string | null;
  variants?: VariantInput[];
}

/** A product with no active variant cannot be bought, so it cannot be published. */
async function assertSellable(db: Queryable, productId: number) {
  const rows = await db.query<{ active: number }>(
    "SELECT count(*)::int AS active FROM product_variant WHERE product_id = $1 AND is_active",
    [productId],
  );
  if ((rows.rows[0]?.active ?? 0) === 0) {
    fail(
      422,
      "VALIDATION_ERROR",
      "Add at least one active variant before publishing this product",
    );
  }
}

/** Brands are free text on `product.brand` but the facet needs a `brand` row. */
async function brandFor(db: Queryable, name: string): Promise<number> {
  const slug = slugify(name);
  const existing = await db.query<{ brand_id: number }>(
    "SELECT brand_id FROM brand WHERE brand_name = $1",
    [name],
  );
  if (existing.rows[0]) return existing.rows[0].brand_id;
  try {
    const inserted = await db.query<{ brand_id: number }>(
      "INSERT INTO brand(brand_name, slug) VALUES($1,$2) RETURNING brand_id",
      [name, slug],
    );
    return inserted.rows[0]!.brand_id;
  } catch {
    // A concurrent insert (or a slug clash) means the row now exists; reuse it.
    const retry = await db.query<{ brand_id: number }>(
      "SELECT brand_id FROM brand WHERE brand_name = $1",
      [name],
    );
    if (retry.rows[0]) return retry.rows[0].brand_id;
    fail(
      409,
      "CONFLICT",
      `The brand slug "${slug}" is already used by another brand`,
    );
  }
}

async function optionValueId(
  db: Queryable,
  productId: number,
  option: string,
  value: string,
): Promise<{ optionId: number; valueId: number }> {
  const optionRow = await db.query<{ option_id: number }>(
    "SELECT option_id FROM product_option WHERE product_id = $1 AND lower(option_name) = lower($2) ORDER BY option_id LIMIT 1",
    [productId, option],
  );
  const optionId =
    optionRow.rows[0]?.option_id ??
    (
      await db.query<{ option_id: number }>(
        `INSERT INTO product_option(product_id, option_name, sort_order)
         VALUES($1,$2,(SELECT count(*) + 1 FROM product_option WHERE product_id = $1))
         RETURNING option_id`,
        [productId, option],
      )
    ).rows[0]!.option_id;

  const valueRow = await db.query<{ option_value_id: number }>(
    "SELECT option_value_id FROM product_option_value WHERE option_id = $1 AND lower(value_name) = lower($2) ORDER BY option_value_id LIMIT 1",
    [optionId, value],
  );
  const valueId =
    valueRow.rows[0]?.option_value_id ??
    (
      await db.query<{ option_value_id: number }>(
        `INSERT INTO product_option_value(option_id, value_name, sort_order)
         VALUES($1,$2,(SELECT count(*) + 1 FROM product_option_value WHERE option_id = $1))
         RETURNING option_value_id`,
        [optionId, value],
      )
    ).rows[0]!.option_value_id;
  return { optionId, valueId };
}

async function writeOptions(
  db: Queryable,
  productId: number,
  variantId: number,
  options: VariantInput["options"],
) {
  if (!options?.length) return;
  for (const { option, value } of options) {
    const { optionId, valueId } = await optionValueId(
      db,
      productId,
      option,
      value,
    );
    await db.query(
      `INSERT INTO variant_option_value(variant_id, option_id, option_value_id) VALUES($1,$2,$3)
       ON CONFLICT (variant_id, option_id) DO UPDATE SET option_value_id = EXCLUDED.option_value_id`,
      [variantId, optionId, valueId],
    );
  }
}

function checkPrices(price: string, compareAt: string | null | undefined) {
  if (compareAt && Number(compareAt) < Number(price)) {
    fail(
      422,
      "VALIDATION_ERROR",
      "The compare-at price cannot be lower than the price",
    );
  }
}

export async function getAdminProduct(db: Queryable, productId: number) {
  const products = await db.query<any>(
    `SELECT p.product_id, p.product_name, p.slug, p.summary, p.description, p.status,
            p.is_featured, p.brand, p.sync_state, p.created_at, p.updated_at, p.erp_updated_at,
            p.seo_title, p.seo_description,
            b.brand_name, b.brand_id,
            (SELECT pc.category_id FROM product_category pc WHERE pc.product_id = p.product_id ORDER BY pc.category_id LIMIT 1) AS category_id,
            c.category_name
       FROM product p
       LEFT JOIN brand b ON b.brand_id = p.brand_id
       LEFT JOIN category c ON c.category_id = (
         SELECT pc.category_id FROM product_category pc WHERE pc.product_id = p.product_id ORDER BY pc.category_id LIMIT 1)
      WHERE p.product_id = $1`,
    [productId],
  );
  const product = products.rows[0];
  if (!product) fail(404, "NOT_FOUND", "Product not found");

  const [variants, images] = await Promise.all([
    db.query<any>(
      `${ADMIN_VARIANT_SELECT} WHERE v.product_id = $1 ORDER BY v.is_default DESC, v.variant_id`,
      [productId],
    ),
    db.query<any>(
      "SELECT image_id, image_url, alt_text, is_primary, sort_order FROM product_image WHERE product_id = $1 ORDER BY is_primary DESC, sort_order",
      [productId],
    ),
  ]);

  return {
    ...product,
    variants: variants.rows.map((variant) => ({
      ...variant,
      price: toMoney(variant.price),
      compare_at_price: variant.compare_at_price
        ? toMoney(variant.compare_at_price)
        : null,
    })),
    images: images.rows,
  };
}

/** A foreign-key miss would surface as "a referenced record does not exist". */
async function assertCategory(
  db: Queryable,
  categoryId: number | null | undefined,
) {
  if (!categoryId) return;
  const found = await db.query(
    "SELECT 1 FROM category WHERE category_id = $1",
    [categoryId],
  );
  if (!found.rows[0])
    fail(422, "VALIDATION_ERROR", `Category ${categoryId} does not exist`);
}

export async function createProduct(db: Queryable, input: ProductInput) {
  const status = input.status ?? "draft";
  const variants = input.variants ?? [];
  if (status === "active" && variants.length === 0) {
    fail(
      422,
      "VALIDATION_ERROR",
      "Add at least one active variant before publishing this product",
    );
  }

  const slug = input.slug?.trim() || slugify(input.product_name);
  if (!slug)
    fail(
      422,
      "VALIDATION_ERROR",
      "A product needs a name that produces a URL slug",
    );
  const clash = await db.query("SELECT 1 FROM product WHERE slug = $1", [slug]);
  if (clash.rows[0]) {
    fail(409, "CONFLICT", `The URL slug "${slug}" is already in use`);
  }

  await assertCategory(db, input.category_id);
  const brandId = input.brand_name
    ? await brandFor(db, input.brand_name)
    : null;
  const inserted = await db.query<{ product_id: number }>(
    `INSERT INTO product(product_name, description, brand, brand_id, slug, status, summary, is_featured, sync_state, updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'local_only', now())
     RETURNING product_id`,
    [
      input.product_name,
      input.description ?? null,
      input.brand_name ?? null,
      brandId,
      slug,
      status,
      input.summary ?? null,
      input.is_featured ?? false,
    ],
  );
  const productId = inserted.rows[0]!.product_id;

  if (input.category_id) {
    await db.query(
      "INSERT INTO product_category(product_id, category_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [productId, input.category_id],
    );
  }

  for (const [index, variant] of variants.entries()) {
    await insertVariant(db, productId, {
      ...variant,
      is_default: variant.is_default ?? index === 0,
    });
  }

  return getAdminProduct(db, productId);
}

/**
 * Set or clear the single primary image.
 *
 * Either an absolute http(s) URL the operator hosts, a path this site serves
 * itself (`/images/x.jpg` from `public/`, or the ERP proxy path the sync writes),
 * anything else — `javascript:`, `data:`, `//elsewhere` — is refused, because the
 * value ends up in an `<img src>` on a public page.
 */
export async function setProductImage(db: Queryable, productId: number, imageUrl: string | null) {
  const product = await db.query<{ product_name: string }>(
    "SELECT product_name FROM product WHERE product_id = $1",
    [productId],
  );
  if (!product.rows[0]) fail(404, "NOT_FOUND", "Product not found");

  const existing = await db.query<{ image_id: number }>(
    "SELECT image_id FROM product_image WHERE product_id = $1 AND is_primary LIMIT 1",
    [productId],
  );

  if (!imageUrl) {
    if (existing.rows[0]) {
      await db.query("DELETE FROM product_image WHERE image_id = $1", [existing.rows[0].image_id]);
    }
    return getAdminProduct(db, productId);
  }

  const url = imageUrl.trim();
  // Absolute https, or a path this site serves itself (files in `public/`).
  // Never protocol-relative (`//host`), which would escape the site.
  const acceptable = /^https?:\/\/[^\s]+$/i.test(url) || /^\/(?!\/)[^\s]*$/.test(url);
  if (!acceptable) {
    fail(422, "VALIDATION_ERROR", "Use an https image URL, or clear the image");
  }

  const alt = product.rows[0].product_name.slice(0, 255);
  if (existing.rows[0]) {
    await db.query("UPDATE product_image SET image_url = $2, alt_text = $3 WHERE image_id = $1", [
      existing.rows[0].image_id,
      url,
      alt,
    ]);
  } else {
    await db.query(
      `INSERT INTO product_image(product_id, image_url, alt_text, is_primary, sort_order)
       VALUES($1,$2,$3,true,1)`,
      [productId, url, alt],
    );
  }
  return getAdminProduct(db, productId);
}

export interface ProductPatch {
  product_name?: string;
  summary?: string;
  description?: string;
  status?: "draft" | "active" | "archived";
  is_featured?: boolean;
  category_id?: number | null;
}

export async function updateProduct(
  db: Queryable,
  productId: number,
  patch: ProductPatch,
) {
  const current = await db.query<any>(
    "SELECT product_id, status FROM product WHERE product_id = $1",
    [productId],
  );
  if (!current.rows[0]) fail(404, "NOT_FOUND", "Product not found");

  if (patch.status === "active") await assertSellable(db, productId);
  await assertCategory(db, patch.category_id);

  const sets: string[] = [];
  const values: unknown[] = [];
  const assign = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.product_name !== undefined) {
    assign("product_name", patch.product_name);
    assign("slug", slugify(patch.product_name));
  }
  if (patch.summary !== undefined) assign("summary", patch.summary || null);
  if (patch.description !== undefined)
    assign("description", patch.description || null);
  if (patch.status !== undefined) assign("status", patch.status);
  if (patch.is_featured !== undefined) assign("is_featured", patch.is_featured);

  if (sets.length) {
    values.push(productId);
    await db.query(
      `UPDATE product SET ${sets.join(", ")}, updated_at = now() WHERE product_id = $${values.length}`,
      values,
    );
  }

  if (patch.category_id !== undefined) {
    await db.query("DELETE FROM product_category WHERE product_id = $1", [
      productId,
    ]);
    if (patch.category_id) {
      await db.query(
        "INSERT INTO product_category(product_id, category_id) VALUES($1,$2)",
        [productId, patch.category_id],
      );
    }
  }

  return getAdminProduct(db, productId);
}

export async function insertVariant(
  db: Queryable,
  productId: number,
  input: VariantInput,
) {
  const product = await db.query(
    "SELECT 1 FROM product WHERE product_id = $1",
    [productId],
  );
  if (!product.rows[0]) fail(404, "NOT_FOUND", "Product not found");
  checkPrices(input.price, input.compare_at_price);

  const sku = input.sku.trim();
  const duplicate = await db.query<any>(
    "SELECT product_id FROM product_variant WHERE sku = $1",
    [sku],
  );
  if (duplicate.rows[0]) {
    fail(
      409,
      "CONFLICT",
      `The SKU "${sku}" is already used by another variant`,
    );
  }

  const isDefault = input.is_default ?? false;
  if (isDefault) {
    await db.query(
      "UPDATE product_variant SET is_default = false, updated_at = now() WHERE product_id = $1 AND is_default",
      [productId],
    );
  }

  const inserted = await db.query<{ variant_id: number }>(
    `INSERT INTO product_variant(product_id, sku, price, compare_at_price, qty_in_stock, barcode, weight_grams, is_default, is_active, updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     RETURNING variant_id`,
    [
      productId,
      sku,
      input.price,
      input.compare_at_price ?? null,
      input.qty_in_stock,
      input.barcode ?? null,
      input.weight_grams ?? null,
      isDefault,
      input.is_active ?? true,
    ],
  );
  const variantId = inserted.rows[0]!.variant_id;
  await writeOptions(db, productId, variantId, input.options);
  return variantRow(db, variantId);
}

export async function variantRow(db: Queryable, variantId: number) {
  const rows = await db.query<any>(
    `${ADMIN_VARIANT_SELECT} WHERE v.variant_id = $1`,
    [variantId],
  );
  const variant = rows.rows[0];
  if (!variant) fail(404, "NOT_FOUND", "Variant not found");
  return {
    ...variant,
    price: toMoney(variant.price),
    compare_at_price: variant.compare_at_price
      ? toMoney(variant.compare_at_price)
      : null,
  };
}

export interface VariantPatch {
  sku?: string;
  price?: string;
  compare_at_price?: string | null;
  qty_in_stock?: number;
  barcode?: string | null;
  weight_grams?: number | null;
  is_active?: boolean;
  is_default?: boolean;
  options?: Array<{ option: string; value: string }>;
}

export async function updateVariant(
  db: Queryable,
  variantId: number,
  patch: VariantPatch,
) {
  const current = await db.query<any>(
    "SELECT variant_id, product_id, price::text AS price, compare_at_price::text AS compare_at_price, is_default FROM product_variant WHERE variant_id = $1",
    [variantId],
  );
  const variant = current.rows[0];
  if (!variant) fail(404, "NOT_FOUND", "Variant not found");

  const nextPrice = patch.price ?? toMoney(variant.price);
  const nextCompare =
    patch.compare_at_price !== undefined
      ? patch.compare_at_price
      : variant.compare_at_price;
  checkPrices(nextPrice, nextCompare);

  if (patch.sku !== undefined) {
    const duplicate = await db.query<any>(
      "SELECT variant_id FROM product_variant WHERE sku = $1 AND variant_id <> $2",
      [patch.sku.trim(), variantId],
    );
    if (duplicate.rows[0])
      fail(
        409,
        "CONFLICT",
        `The SKU "${patch.sku}" is already used by another variant`,
      );
  }

  if (patch.is_default === true) {
    await db.query(
      "UPDATE product_variant SET is_default = false, updated_at = now() WHERE product_id = $1 AND variant_id <> $2",
      [variant.product_id, variantId],
    );
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  const assign = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.sku !== undefined) assign("sku", patch.sku.trim());
  if (patch.price !== undefined) assign("price", patch.price);
  if (patch.compare_at_price !== undefined)
    assign("compare_at_price", patch.compare_at_price);
  if (patch.qty_in_stock !== undefined)
    assign("qty_in_stock", patch.qty_in_stock);
  if (patch.barcode !== undefined) assign("barcode", patch.barcode || null);
  if (patch.weight_grams !== undefined)
    assign("weight_grams", patch.weight_grams);
  if (patch.is_active !== undefined) assign("is_active", patch.is_active);
  if (patch.is_default !== undefined) assign("is_default", patch.is_default);

  if (sets.length) {
    values.push(variantId);
    await db.query(
      `UPDATE product_variant SET ${sets.join(", ")}, updated_at = now() WHERE variant_id = $${values.length}`,
      values,
    );
  }

  if (patch.options) {
    await db.query("DELETE FROM variant_option_value WHERE variant_id = $1", [
      variantId,
    ]);
    await writeOptions(db, variant.product_id, variantId, patch.options);
  }

  return variantRow(db, variantId);
}
