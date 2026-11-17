import { Suspense } from "react";
import Link from "next/link";
import { CatalogueGrid } from "@/components/CatalogueGrid";
import { GridSkeleton } from "@/components/GridSkeleton";
import { SearchBar } from "@/components/SearchBar";
import { SortSelect } from "@/components/SortSelect";
import { listBrands, listCategories } from "@/lib/server-api";

export const dynamic = "force-dynamic";

interface Search {
  q?: string;
  category?: string;
  brand?: string;
  sort?: string;
  page?: string;
}

const SORTS = new Set(["newest", "price_asc", "price_desc", "name"]);

/** Build a catalogue URL from the current filters plus an override set. */
export function href(current: Search, overrides: Partial<Search>): string {
  const merged: Search = { ...current, ...overrides };
  const search = new URLSearchParams();
  for (const key of ["q", "category", "brand", "sort", "page"] as const) {
    const value = merged[key];
    if (value) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `/?${query}` : "/";
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").trim().slice(0, 120);
  const category = (params.category ?? "").trim();
  const brand = (params.brand ?? "").trim();
  const sort = params.sort && SORTS.has(params.sort) ? params.sort : "newest";
  const page = Math.min(500, Math.max(1, Number(params.page) || 1));

  // Facets are small and fast; the catalogue itself streams in below so the
  // page shell and filters paint without waiting for it.
  const [categories, brands] = await Promise.all([
    listCategories(),
    listBrands(),
  ]);

  const filtered = Boolean(q || category || brand);
  const currentFilters: Search = {
    q,
    category,
    brand,
    sort,
    page: page > 1 ? String(page) : undefined,
  };
  const visibleCategories = categories
    .filter((entry) => entry.product_count > 0)
    .slice(0, 10);
  const visibleBrands = brands
    .filter((entry) => entry.product_count > 0)
    .slice(0, 8);

  return (
    <main>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Duka storefront</span>
          <h1>Shop the collection</h1>
          <p>
            Live stock and prices straight from the ERP. Adding an item holds it
            for 15 minutes, and delivery is arranged by our team.
          </p>
        </div>
        <div
          className="heading-actions"
          style={{ flex: 1, justifyContent: "flex-end" }}
        >
          <SearchBar
            q={q}
            category={category}
            brand={brand}
            sort={sort === "newest" ? undefined : sort}
            id="hero-search"
          />
          <SortSelect value={sort} filters={{ q, category, brand }} />
        </div>
      </div>

      {q ? (
        <p className="muted small" style={{ marginBottom: 12 }}>
          Searching for “{q}” ·{" "}
          <Link
            className="text-link"
            href={href(currentFilters, { q: undefined, page: undefined })}
          >
            clear
          </Link>
        </p>
      ) : null}

      {visibleCategories.length > 0 ? (
        <div className="category-tabs" role="group" aria-label="Categories">
          <Link
            href={href(currentFilters, {
              category: undefined,
              page: undefined,
            })}
            aria-pressed={!category}
          >
            All products
          </Link>
          {visibleCategories.map((entry) => (
            <Link
              key={entry.category_id}
              href={href(currentFilters, {
                category: entry.slug,
                page: undefined,
              })}
              aria-pressed={category === entry.slug}
            >
              {entry.category_name}
              <span className="count">{entry.product_count}</span>
            </Link>
          ))}
        </div>
      ) : null}

      {visibleBrands.length > 0 ? (
        <div
          className="category-tabs"
          style={{ marginTop: -8 }}
          role="group"
          aria-label="Brands"
        >
          {visibleBrands.map((entry) => (
            <Link
              key={entry.brand_id}
              href={href(currentFilters, {
                brand: brand === entry.slug ? undefined : entry.slug,
                page: undefined,
              })}
              aria-pressed={brand === entry.slug}
            >
              {entry.brand_name}
            </Link>
          ))}
        </div>
      ) : null}

      {filtered ? (
        <div className="toolbar-filters" style={{ marginBottom: 14 }}>
          <Link className="btn ghost sm" href="/">
            Clear filters
          </Link>
          <span className="muted small">
            {[
              q ? `“${q}”` : null,
              category ? `category: ${category}` : null,
              brand ? `brand: ${brand}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      ) : null}

      <Suspense fallback={<GridSkeleton />}>
        <CatalogueGrid
          query={{ q, category, brand, sort, page, limit: 24 }}
          filters={currentFilters}
        />
      </Suspense>
    </main>
  );
}
