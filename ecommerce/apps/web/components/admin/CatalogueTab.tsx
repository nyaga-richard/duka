"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyRow, Panel, Status } from "@/components/admin/atoms";
import { when, type AdminProduct } from "@/components/admin/types";
import { useToast } from "@/components/ui/Toast";
import { api, ApiError } from "@/lib/api-client";

/**
 * Catalogue: what the storefront publishes. Stock and prices stay ERP-owned, so
 * the only local lever is the product status — publish, unpublish, archive.
 */
export function CatalogueTab({ refreshToken }: { refreshToken: number }) {
  const { toast } = useToast();
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [query, setQuery] = useState({ q: "", status: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

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
      await api(`/admin/products/${product.product_id}/status`, {
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

  const published = products.filter(
    (product) => product.status === "active",
  ).length;

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
            <span className="muted small">
              {loading
                ? "Loading…"
                : `${products.length} shown · ${published} published`}
            </span>
          </div>
        </form>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Status</th>
                <th>Sync</th>
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
                    : "No products match. Pull the catalogue from the ERP or create products locally."}
                </EmptyRow>
              ) : (
                products.map((product) => (
                  <tr key={product.product_id}>
                    <td>
                      <strong>{product.product_name}</strong>
                      <div className="muted tiny">
                        /{product.slug}
                        {product.erp_product_id
                          ? ` · ERP #${product.erp_product_id}`
                          : " · local"}
                      </div>
                    </td>
                    <td>
                      <Status value={product.status} />
                    </td>
                    <td>
                      {product.sync_state ? (
                        <Status value={product.sync_state} />
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                    <td className="num">{product.variants}</td>
                    <td className="muted small">{when(product.updated_at)}</td>
                    <td className="num">
                      <span className="row-actions">
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
                        {product.status !== "archived" ? (
                          <button
                            className="btn ghost sm"
                            type="button"
                            disabled={busy === product.product_id}
                            onClick={() => setStatus(product, "archived")}
                          >
                            Archive
                          </button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="card-note">
          Stock and prices stay owned by the ERP; this only controls what the
          storefront publishes.
        </p>
      </Panel>
    </section>
  );
}
