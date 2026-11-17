/**
 * Server-side catalogue reads. Public data only, fetched from the shop API
 * inside the private network — never from the browser.
 *
 * Shapes here mirror the API's `mapProduct` output exactly: images arrive as
 * `{ url, alt, is_primary }` (not `image_url`), and the cheapest variant price
 * is `price_from`.
 */
const API = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4100";

export interface ProductVariant {
  variant_id: number;
  sku: string;
  price: string;
  compare_at_price?: string | null;
  available: number;
  in_stock?: boolean;
  is_default?: boolean;
  options?: Array<{ option: string; value: string }>;
}

export interface ProductImage {
  url: string;
  alt?: string | null;
  is_primary?: boolean;
}

export interface ProductSummary {
  product_id: number;
  name: string;
  slug: string;
  summary?: string | null;
  brand?: string | null;
  category?: string | null;
  category_slug?: string | null;
  featured?: boolean;
  images?: ProductImage[];
  variants?: ProductVariant[];
  price_from?: string | null;
}

export interface ProductDetail extends ProductSummary {
  description?: string | null;
  attributes?: Array<{ key: string; label: string; value: string }>;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface Category {
  category_id: number;
  category_name: string;
  slug: string;
  product_count: number;
}

export interface Brand {
  brand_id: number;
  brand_name: string;
  slug: string;
  product_count: number;
}

export interface Review {
  review_id: number;
  rating: number;
  title?: string | null;
  comment?: string | null;
  created_at: string;
  first_name?: string | null;
  last_initial?: string | null;
}

export interface ReviewPage extends Page<Review> {
  average_rating: string | null;
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${API}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return (body?.data ?? null) as T;
  } catch {
    return null;
  }
}

export interface CatalogueQuery {
  q?: string;
  category?: string;
  brand?: string;
  sort?: string;
  page?: number;
  limit?: number;
}

export function cataloguePath(query: CatalogueQuery): string {
  const search = new URLSearchParams();
  search.set("limit", String(query.limit ?? 24));
  search.set("page", String(query.page ?? 1));
  if (query.sort) search.set("sort", query.sort);
  if (query.q) search.set("q", query.q);
  if (query.category) search.set("category", query.category);
  if (query.brand) search.set("brand", query.brand);
  return `/api/v1/catalog/products?${search.toString()}`;
}

export async function listCatalogue(
  query: CatalogueQuery = {},
): Promise<Page<ProductSummary>> {
  const data = await getJson<Page<ProductSummary>>(cataloguePath(query));
  return (
    data ?? {
      items: [],
      page: query.page ?? 1,
      limit: query.limit ?? 24,
      total: 0,
      pages: 1,
    }
  );
}

export async function listProducts(query = ""): Promise<ProductSummary[]> {
  const data = await getJson<Page<ProductSummary>>(
    `/api/v1/catalog/products${query}`,
  );
  return data?.items ?? [];
}

/**
 * Products the store flagged as featured, for the landing page. Falls back to
 * the newest published products when nothing is featured yet, so a fresh shop
 * still has something to show above the fold.
 */
export async function listFeatured(limit = 8): Promise<ProductSummary[]> {
  const featured = await listProducts(
    `?featured=true&limit=${Math.min(limit, 48)}`,
  );
  if (featured.length) return featured;
  return listProducts(`?limit=${Math.min(limit, 48)}&sort=newest`);
}

export async function getProduct(slug: string): Promise<ProductDetail | null> {
  return getJson<ProductDetail>(
    `/api/v1/catalog/products/${encodeURIComponent(slug)}`,
  );
}

/** The API wraps list payloads as `{ data: { items: [] } }`; older builds
 *  returned a bare array, so both shapes are accepted. */
function listItems<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const items = (data as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

export async function listCategories(): Promise<Category[]> {
  return listItems<Category>(
    await getJson<unknown>("/api/v1/catalog/categories"),
  );
}

export async function listBrands(): Promise<Brand[]> {
  return listItems<Brand>(await getJson<unknown>("/api/v1/catalog/brands"));
}

export async function listReviews(
  slug: string,
  limit = 10,
): Promise<ReviewPage> {
  const data = await getJson<ReviewPage>(
    `/api/v1/catalog/products/${encodeURIComponent(slug)}/reviews?limit=${limit}`,
  );
  return (
    data ?? {
      items: [],
      page: 1,
      limit,
      total: 0,
      pages: 1,
      average_rating: null,
    }
  );
}

/** Cheapest variant price, formatted for display; `null` when there are none. */
export function priceFrom(product: ProductSummary): string | null {
  const priced = (product.variants ?? []).filter(
    (variant) => variant.price != null,
  );
  if (priced.length) {
    const cheapest = priced.reduce((min, variant) =>
      Number(variant.price) < Number(min.price) ? variant : min,
    );
    return cheapest.price;
  }
  return product.price_from ?? null;
}

/** Total units available across variants — drives the stock badge. */
export function stockOf(product: ProductSummary): number {
  return (product.variants ?? []).reduce(
    (sum, variant) => sum + (variant.available ?? 0),
    0,
  );
}

export function primaryImage(product: ProductSummary): ProductImage | null {
  const images = product.images ?? [];
  return images.find((image) => image.is_primary) ?? images[0] ?? null;
}

export function money(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return `KES ${Number(value).toLocaleString("en-KE")}`;
}
