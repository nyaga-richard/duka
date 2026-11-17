import { Suspense } from "react";
import Link from "next/link";
import { ChevronRightIcon } from "@/components/icons";
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
  return query ? `/shop?${query}` : "/shop";
}

export default async function ShopPage({
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
  // `sort` only rides along when it is not the default, so a chip that removes
  // the search does not leave `?sort=newest` behind.
  const currentFilters: Search = {
    q,
    brand,
    category,
    sort: sort === "newest" ? undefined : sort,
    page: page > 1 ? String(page) : undefined,
  };
  const visibleCategories = categories
    .filter((entry) => entry.product_count > 0)
    .slice(0, 10);
  const visibleBrands = brands
    .filter((entry) => entry.product_count > 0)
    .slice(0, 8);

  // The chips name the filter a shopper applied, not the slug in the URL.
  const categoryName =
    visibleCategories.find((entry) => entry.slug === category)?.category_name ??
    category;
  const brandName =
    visibleBrands.find((entry) => entry.slug === brand)?.brand_name ?? brand;

  return (
    <main>
      <nav
        className="breadcrumbs"
        aria-label="Breadcrumb"
        style={{ marginBottom: 14 }}
      >
        <Link href="/">Home</Link>
        <ChevronRightIcon size={12} />
        <strong>Shop</strong>
      </nav>

      <section className="shop-hero">
        <div className="shop-hero-copy">
          <span className="eyebrow">Duka storefront</span>
          <h1>The whole catalogue</h1>
          <p>
            Live stock and prices straight from the ERP. Adding an item holds it
            for 15 minutes, and our team arranges delivery after checkout.
          </p>
          <div className="hero-points">
            <span className="badge ok">
              <span className="status-dot" />
              Live ERP stock
            </span>
            <span className="badge">15-minute hold</span>
            <span className="badge">Nairobi delivery</span>
          </div>
        </div>
        <div className="shop-hero-search">
          <label className="eyebrow" htmlFor="hero-search">
            Find something
          </label>
          <SearchBar
            action="/shop"
            q={q}
            category={category}
            brand={brand}
            sort={sort === "newest" ? undefined : sort}
            id="hero-search"
          />
        </div>
      </section>

      {visibleCategories.length > 0 || visibleBrands.length > 0 ? (
        <section
          className="filter-strip"
          aria-label="Browse by category or brand"
        >
          {visibleCategories.length > 0 ? (
            <div className="filter-row">
              <span className="eyebrow">Category</span>
              <div
                className="category-tabs"
                role="group"
                aria-label="Categories"
              >
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
            </div>
          ) : null}

          {visibleBrands.length > 0 ? (
            <div className="filter-row">
              <span className="eyebrow">Brand</span>
              <div className="category-tabs" role="group" aria-label="Brands">
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
            </div>
          ) : null}
        </section>
      ) : null}

      {/* One place for what is applied, one way to remove each piece: a chip
          per filter. The old layout said the same thing twice ("Searching for …
          clear" and a "Clear filters" block) and neither could remove a single
          filter. */}
      <div className="filter-bar">
        {filtered ? (
          <>
            {q ? (
              <Link
                className="chip"
                href={href(currentFilters, { q: undefined, page: undefined })}
                title="Remove search"
              >
                <span>Search</span> <strong>“{q}”</strong> ×
              </Link>
            ) : null}
            {category ? (
              <Link
                className="chip"
                href={href(currentFilters, {
                  category: undefined,
                  page: undefined,
                })}
                title="Remove category filter"
              >
                <span>Category</span> <strong>{categoryName}</strong> ×
              </Link>
            ) : null}
            {brand ? (
              <Link
                className="chip"
                href={href(currentFilters, {
                  brand: undefined,
                  page: undefined,
                })}
                title="Remove brand filter"
              >
                <span>Brand</span> <strong>{brandName}</strong> ×
              </Link>
            ) : null}
            <Link className="chip chip-clear" href="/shop">
              Clear all
            </Link>
          </>
        ) : (
          <span className="muted small">
            Every published product, newest first.
          </span>
        )}
        <span className="grow" />
        <SortSelect
          value={sort}
          basePath="/shop"
          filters={{ q, category, brand }}
        />
      </div>

      <Suspense fallback={<GridSkeleton />}>
        <CatalogueGrid
          basePath="/shop"
          query={{ q, category, brand, sort, page, limit: 24 }}
          filters={currentFilters}
        />
      </Suspense>
    </main>
  );
}
