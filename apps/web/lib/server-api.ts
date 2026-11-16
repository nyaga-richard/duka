/** Server-side catalogue reads. These pages render public data only. */
const API = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4100";

export interface ProductSummary {
  product_id: number;
  name: string;
  slug: string;
  summary?: string | null;
  image_url?: string | null;
  min_price?: string;
  variants?: Array<{ variant_id: number; sku: string; price: string; available: number }>;
}

export async function getJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${API}${path}`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json();
    return (body?.data ?? null) as T;
  } catch {
    return null;
  }
}

export async function listProducts(query = ""): Promise<ProductSummary[]> {
  const data = await getJson<{ items: ProductSummary[] }>(`/api/v1/catalog/products${query}`);
  return data?.items ?? [];
}

export async function getProduct(slug: string) {
  return getJson<{
    product_id: number;
    name: string;
    slug: string;
    description?: string | null;
    summary?: string | null;
    images?: Array<{ image_url: string; alt_text?: string | null }>;
    variants: Array<{ variant_id: number; sku: string; price: string; available: number; options?: Array<{ option: string; value: string }> }>;
  }>(`/api/v1/catalog/products/${encodeURIComponent(slug)}`);
}
