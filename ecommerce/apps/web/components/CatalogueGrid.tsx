import Link from "next/link";
import { ProductCard } from "@/components/ProductCard";
import { listCatalogue, type CatalogueQuery } from "@/lib/server-api";

type Filters = { q?: string; category?: string; brand?: string; sort?: string; page?: string };

/** Same URL builder as the page, kept local so this component stays standalone. */
function href(current: Filters, overrides: Partial<Filters>): string {
  const merged: Filters = { ...current, ...overrides };
  const search = new URLSearchParams();
  for (const key of ["q", "category", "brand", "sort", "page"] as const) {
    const value = merged[key];
    if (value) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `/?${query}` : "/";
}

/**
 * The catalogue itself. Streamed inside its own Suspense boundary so the hero,
 * search and filters paint immediately. The skeleton lives here rather than in
 * a route-level `loading.tsx` on purpose: a route-level boundary starts
 * streaming a 200 before `notFound()` can run, which would break real 404s on
 * the product routes.
 */
export async function CatalogueGrid({ query, filters }: { query: CatalogueQuery; filters: Filters }) {
  const { items, total, pages, page } = await listCatalogue(query);
  const filtered = Boolean(filters.q || filters.category || filters.brand);

  if (total === 0) {
    return (
      <div className="empty">
        <h2>{filtered ? "Nothing matches those filters" : "The shop is being stocked"}</h2>
        <p style={{ marginBottom: "1rem" }}>
          {filtered
            ? "Try a shorter search, or clear the filters to see everything."
            : "No published products yet. An administrator must enable the ERP integration and run a catalogue pull, or create products locally."}
        </p>
        {filtered ? (
          <Link className="button" href="/">
            Browse everything
          </Link>
        ) : (
          <Link className="button secondary" href="/admin">
            Staff sign-in
          </Link>
        )}
      </div>
    );
  }

  return (
    <>
      <p className="small muted" style={{ margin: "0 0 0.75rem" }}>
        {filtered ? `${total} result${total === 1 ? "" : "s"}` : `${total} product${total === 1 ? "" : "s"}`}
        {pages > 1 ? ` · page ${page} of ${pages}` : ""}
      </p>

      <div className="grid">
        {items.map((product) => (
          <ProductCard key={product.product_id} product={product} />
        ))}
      </div>

      {pages > 1 ? (
        <nav className="pager" aria-label="Pagination">
          {page > 1 ? (
            <Link className="button secondary" href={href(filters, { page: page - 1 === 1 ? undefined : String(page - 1) })}>
              ← Previous
            </Link>
          ) : (
            <span className="button secondary" aria-disabled="true" style={{ opacity: 0.5 }}>
              ← Previous
            </span>
          )}
          <span className="small muted">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link className="button secondary" href={href(filters, { page: String(page + 1) })}>
              Next →
            </Link>
          ) : (
            <span className="button secondary" aria-disabled="true" style={{ opacity: 0.5 }}>
              Next →
            </span>
          )}
        </nav>
      ) : null}
    </>
  );
}
