import Link from "next/link";
import { ProductCard } from "@/components/ProductCard";
import { listCatalogue, type CatalogueQuery } from "@/lib/server-api";

type Filters = {
  q?: string;
  category?: string;
  brand?: string;
  sort?: string;
  page?: string;
};

/** Same URL builder as the page, kept local so this component stays standalone. */
function href(
  current: Filters,
  overrides: Partial<Filters>,
  basePath: string,
): string {
  const merged: Filters = { ...current, ...overrides };
  const search = new URLSearchParams();
  for (const key of ["q", "category", "brand", "sort", "page"] as const) {
    const value = merged[key];
    if (value) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${basePath}?${query}` : basePath;
}

/**
 * The catalogue itself. Streamed inside its own Suspense boundary so the page
 * heading, search and filters paint immediately. The skeleton lives here rather
 * than in a route-level `loading.tsx` on purpose: a route-level boundary starts
 * streaming a 200 before `notFound()` can run, which would break real 404s on
 * the product routes.
 */
export async function CatalogueGrid({
  query,
  filters,
  basePath = "/shop",
}: {
  query: CatalogueQuery;
  filters: Filters;
  /** The catalogue route; pagination links are built against it. */
  basePath?: string;
}) {
  const { items, total, pages, page } = await listCatalogue(query);
  const filtered = Boolean(filters.q || filters.category || filters.brand);

  if (total === 0) {
    return (
      <div className="card">
        <div className="empty">
          <h2>
            {filtered
              ? "Nothing matches those filters"
              : "The shop is being stocked"}
          </h2>
          <p>
            {filtered
              ? "Try a shorter search, or clear the filters to see everything."
              : "No published products yet. An administrator must enable the ERP integration and run a catalogue pull, or create products locally."}
          </p>
          {filtered ? (
            <Link className="btn primary sm" href={basePath}>
              Browse everything
            </Link>
          ) : (
            <Link className="btn outline sm" href="/admin">
              Staff sign-in
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <p className="muted small" style={{ margin: "0 0 10px" }}>
        {filtered
          ? `${total} result${total === 1 ? "" : "s"}`
          : `${total} product${total === 1 ? "" : "s"}`}
        {pages > 1 ? ` · page ${page} of ${pages}` : ""}
      </p>

      <div className="product-grid">
        {items.map((product) => (
          <ProductCard key={product.product_id} product={product} />
        ))}
      </div>

      {pages > 1 ? (
        <nav
          className="pagination"
          aria-label="Pagination"
          style={{ marginTop: 18, borderTop: 0 }}
        >
          {page > 1 ? (
            <Link
              className="btn secondary"
              href={href(
                filters,
                { page: page - 1 === 1 ? undefined : String(page - 1) },
                basePath,
              )}
            >
              ← Previous
            </Link>
          ) : (
            <span
              className="btn secondary"
              aria-disabled="true"
              style={{ opacity: 0.5 }}
            >
              ← Previous
            </span>
          )}
          <span className="small muted">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link
              className="btn secondary"
              href={href(filters, { page: String(page + 1) }, basePath)}
            >
              Next →
            </Link>
          ) : (
            <span
              className="btn secondary"
              aria-disabled="true"
              style={{ opacity: 0.5 }}
            >
              Next →
            </span>
          )}
        </nav>
      ) : null}
    </>
  );
}
