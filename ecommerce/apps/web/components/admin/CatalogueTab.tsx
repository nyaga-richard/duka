"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyRow, Panel, Status } from "@/components/admin/atoms";
import { ProductSheet } from "@/components/admin/ProductSheet";
import { when, type AdminProduct } from "@/components/admin/types";
import { useToast } from "@/components/ui/Toast";
import { api, ApiError } from "@/lib/api-client";

/**
 * Catalogue: what the storefront publishes.
 *
 * Three decisions live here — is it published, is it featured on the landing
 * page, and what does it cost / how many are on hand per variant. All three are
 * local merchandising: an ERP-mirrored product keeps taking its price and stock
 * from the next sync.
 */
export function CatalogueTab({ refreshToken }: { refreshToken: number }) {
  const { toast } = useToast();
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [query, setQuery] = useState({ q: "", status: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | "new" | null>(null);

  const load = useCallback(
    async (next: { q: string; status: string }) => {
      setLoading(true);
      try {
        const search = new URLSearchParams({ limit: "50", page: "1" });
        if (next.q.trim()) search.set("q", next.q.trim());
        if (next.status) search.set("status", next.status);
        const data = await api<{ items: AdminProduct[] }>(
          `/admin/products?${search.toString()}`,
        );
        setProducts(data.items);
      } catch (caught) {
        toast({
          title: "Could not load the catalogue",
          description: caught instanceof ApiError ? caught.message : undefined,
          variant: "error",
        });
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  async function setStatus(
    product: AdminProduct,
    status: AdminProduct["status"],
  ) {
    setBusy(product.product_id);
    try {
      await api(`/admin/products/${product.product_id}`, {
        method: "PATCH",
        body: { status },
      });
      setProducts((current) =>
        current.map((row) =>
          row.product_id === product.product_id ? { ...row, status } : row,
        ),
      );
      toast({ title: `${product.product_name} → ${status}` });
    } catch (caught) {
      toast({
        title: "Could not change the product",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  async function toggleFeatured(product: AdminProduct) {
    const next = !product.is_featured;
    setBusy(product.product_id);
    try {
      await api(`/admin/products/${product.product_id}`, {
        method: "PATCH",
        body: { is_featured: next },
      });
      setProducts((current) =>
        current.map((row) =>
          row.product_id === product.product_id
            ? { ...row, is_featured: next }
            : row,
        ),
      );
      toast({
        title: next
          ? "Featured on the front page"
          : "Removed from the front page",
        description: next ? product.product_name : undefined,
      });
    } catch (caught) {
      toast({
        title: "Could not change the feature flag",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  const published = products.filter(
    (product) => product.status === "active",
  ).length;
  const featured = products.filter((product) => product.is_featured).length;

  return (
    <section
      role="tabpanel"
      id="panel-catalogue"
      aria-labelledby="tab-catalogue"
    >
      <Panel flush>
        <form
          className="table-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            void load(query);
          }}
        >
          <div className="search-box">
            <input
              type="search"
              placeholder="Search the catalogue"
              aria-label="Search the catalogue"
              value={query.q}
              onChange={(event) =>
                setQuery({ ...query, q: event.target.value })
              }
            />
          </div>
          <div className="toolbar-filters">
            <select
              aria-label="Filter by status"
              value={query.status}
              onChange={(event) => {
                const next = { ...query, status: event.target.value };
                setQuery(next);
                void load(next);
              }}
            >
              <option value="">All statuses</option>
              <option value="active">Published</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
            <button className="btn secondary sm" type="submit">
              Search
            </button>
            <button
              className="btn primary sm"
              type="button"
              onClick={() => setEditing("new")}
            >
              New product
            </button>
            <span className="muted small">
              {loading
                ? "Loading…"
                : `${products.length} shown · ${published} published · ${featured} featured`}
            </span>
          </div>
        </form>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Status</th>
                <th>Featured</th>
                <th className="num">Variants</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <EmptyRow colSpan={6}>
                  {loading
                    ? "Loading the catalogue…"
                    : "No products match. Create one here, or pull the catalogue from the ERP."}
                </EmptyRow>
              ) : (
                products.map((product) => (
                  <tr key={product.product_id}>
                    <td>
                      <button
                        className="link-button"
                        type="button"
                        onClick={() => setEditing(product.product_id)}
                      >
                        <strong>{product.product_name}</strong>
                      </button>
                      <div className="muted tiny">
                        {product.category_name
                          ? `${product.category_name} · `
                          : ""}
                        /{product.slug}
                        {product.erp_product_id
                          ? ` · ERP #${product.erp_product_id}`
                          : " · local"}
                      </div>
                    </td>
                    <td>
                      <Status value={product.status} />
                      {product.sync_state ? (
                        <div className="muted tiny">{product.sync_state}</div>
                      ) : null}
                    </td>
                    <td>
                      <button
                        className="feature-flag"
                        type="button"
                        aria-pressed={product.is_featured}
                        disabled={busy === product.product_id}
                        onClick={() => toggleFeatured(product)}
                        title={
                          product.is_featured
                            ? "Remove from the landing page"
                            : "Feature on the landing page"
                        }
                      >
                        {product.is_featured ? "★ Featured" : "☆ Feature"}
                      </button>
                    </td>
                    <td className="num">
                      {product.active_variants}/{product.variants}
                    </td>
                    <td className="muted small">{when(product.updated_at)}</td>
                    <td className="num">
                      <span className="row-actions">
                        <button
                          className="btn ghost sm"
                          type="button"
                          onClick={() => setEditing(product.product_id)}
                        >
                          Edit
                        </button>
                        {product.status !== "active" ? (
                          <button
                            className="btn primary sm"
                            type="button"
                            disabled={busy === product.product_id}
                            onClick={() => setStatus(product, "active")}
                          >
                            Publish
                          </button>
                        ) : (
                          <button
                            className="btn outline sm"
                            type="button"
                            disabled={busy === product.product_id}
                            onClick={() => setStatus(product, "draft")}
                          >
                            Unpublish
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="card-note">
          Publishing controls what the shop lists; featuring controls what the
          landing page leads with. Variants carry their own price, stock and
          publish flag.
        </p>
      </Panel>

      <ProductSheet
        productId={editing}
        onClose={() => setEditing(null)}
        onChanged={async () => {
          await load(query);
        }}
      />
    </section>
  );
}
