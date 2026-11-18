/**
 * Product images, served from the shop but owned by the ERP.
 *
 * The ERP stores a product's photo as an attachment and exposes
 * `GET /api/v1/attachments/:id` (catalog.read). Rather than copy bytes at sync
 * time, the catalogue pull records the attachment in `product_image` as
 * `/api/v1/catalog/images/<attachmentId>`, and this module fetches it on demand
 * — behind a small in-memory cache — with the adapter's own session. That keeps
 * the shop's database free of binary blobs and means replacing the photo in the
 * ERP shows up here without another pull.
 */
import type { Queryable } from "../db/index.ts";
import { erpEnabled, getErpAdapter } from "../integrations/erp.ts";

export const IMAGE_PATH_PREFIX = "/api/v1/catalog/images/";

/** Stable public URL for an ERP attachment, stored in `product_image.image_url`. */
export function erpImageUrl(attachmentId: string): string {
  return `${IMAGE_PATH_PREFIX}${attachmentId}`;
}

/** True for URLs this module serves; those must never be fetched by a browser. */
export function isErpImageUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(IMAGE_PATH_PREFIX);
}

/** 1×1 transparent PNG: what a browser gets when the ERP cannot be reached. */
const TRANSPARENT_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  ),
);

interface CacheEntry {
  bytes: Uint8Array;
  contentType: string;
  etag: string;
  fetchedAt: number;
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 64;
const cache = new Map<string, CacheEntry>();

export function clearImageCache(): void {
  cache.clear();
}

export interface ServedImage {
  bytes: Uint8Array;
  contentType: string;
  etag: string;
  cacheControl: string;
  /** `erp` when the bytes came from the ERP, `placeholder` when they could not. */
  source: "erp" | "placeholder";
}

/**
 * Serve one published product image.
 *
 * Only attachment ids that appear on a published product's `product_image` row
 * are fetchable, so this cannot be used as a general ERP file downloader.
 * A missing ERP connection degrades to a transparent pixel rather than a broken
 * image icon, and the response is explicitly uncacheable in that case.
 */
export async function loadProductImage(
  db: Queryable,
  attachmentId: string,
): Promise<ServedImage | null> {
  const url = erpImageUrl(attachmentId);
  const known = await db.query(
    `SELECT 1 FROM product_image i
       JOIN product p ON p.product_id = i.product_id
      WHERE i.image_url = $1 AND p.status = 'active'
      LIMIT 1`,
    [url],
  );
  if (!known.rows[0]) return null;

  const etag = `"img-${attachmentId}"`;
  const cached = cache.get(attachmentId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached, cacheControl: "public, max-age=600", source: "erp" };
  }

  const adapter = erpEnabled() ? getErpAdapter() : null;
  if (!adapter) {
    return {
      bytes: TRANSPARENT_PNG,
      contentType: "image/png",
      etag: `"placeholder-${attachmentId}"`,
      cacheControl: "no-store",
      source: "placeholder",
    };
  }

  try {
    const binary = await adapter.downloadAttachment(attachmentId);
    const contentType = binary.contentType.startsWith("image/")
      ? binary.contentType
      : "application/octet-stream";
    const entry: CacheEntry = {
      bytes: binary.bytes,
      contentType,
      etag,
      fetchedAt: Date.now(),
    };
    if (cache.size >= CACHE_MAX) {
      const oldest = [...cache.entries()].sort(
        (a, b) => a[1].fetchedAt - b[1].fetchedAt,
      )[0];
      if (oldest) cache.delete(oldest[0]);
    }
    cache.set(attachmentId, entry);
    return { ...entry, cacheControl: "public, max-age=600", source: "erp" };
  } catch {
    // The ERP is down or the attachment is gone: show nothing, cache nothing.
    return {
      bytes: TRANSPARENT_PNG,
      contentType: "image/png",
      etag: `"placeholder-${attachmentId}"`,
      cacheControl: "no-store",
      source: "placeholder",
    };
  }
}
