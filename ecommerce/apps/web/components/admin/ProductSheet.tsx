"use client";

import { useCallback, useEffect, useState } from "react";
import { Overlay } from "@/components/ui/Overlay";
import { useToast } from "@/components/ui/Toast";
import { Status } from "@/components/admin/atoms";
import {
  when,
  type AdminProductDetail,
  type AdminVariant,
} from "@/components/admin/types";
import { api, ApiError } from "@/lib/api-client";

interface Category {
  category_id: number;
  category_name: string;
}

interface VariantForm {
  sku: string;
  price: string;
  qty_in_stock: string;
  compare_at_price: string;
  is_active: boolean;
  option_name: string;
  option_value: string;
}

const emptyVariant = (): VariantForm => ({
  sku: "",
  price: "",
  qty_in_stock: "0",
  compare_at_price: "",
  is_active: true,
  option_name: "",
  option_value: "",
});

const fromVariant = (variant: AdminVariant): VariantForm => ({
  sku: variant.sku,
  price: variant.price,
  qty_in_stock: String(variant.qty_in_stock),
  compare_at_price: variant.compare_at_price ?? "",
  is_active: variant.is_active,
  option_name: variant.options[0]?.option ?? "",
  option_value: variant.options[0]?.value ?? "",
});

/**
 * One product, everything the desk can decide about it: what it is called, the
 * words the storefront shows, whether it is published, whether it is featured on
 * the front page, and its variants — each with its own price, stock on hand and
 * publish flag. Prices and stock for ERP-mirrored products are still the ERP's
 * on the next pull; this is the local merchandising view.
 */
export function ProductSheet({
  productId,
  onClose,
  onChanged,
}: {
  /** `"new"` opens a blank create form; a number opens that product. */
  productId: number | "new" | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { toast } = useToast();
  const open = productId !== null;
  const creating = productId === "new";

  const [product, setProduct] = useState<AdminProductDetail | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);

  const [form, setForm] = useState({
    product_name: "",
    summary: "",
    description: "",
    status: "draft" as "draft" | "active" | "archived",
    is_featured: false,
    category_id: "",
    brand_name: "",
  });

  const [editingVariant, setEditingVariant] = useState<number | "new" | null>(
    null,
  );
  const [variantForm, setVariantForm] = useState<VariantForm>(emptyVariant());

  const load = useCallback(async () => {
    if (typeof productId !== "number") return;
    setLoading(true);
    try {
      const result = await api<{ product: AdminProductDetail }>(
        `/admin/products/${productId}`,
      );
      const loaded = result.product;
      setProduct(loaded);
      setForm({
        product_name: loaded.product_name,
        summary: loaded.summary ?? "",
        description: loaded.description ?? "",
        status: loaded.status,
        is_featured: loaded.is_featured,
        category_id: loaded.category_id ? String(loaded.category_id) : "",
        brand_name: loaded.brand_name ?? loaded.brand ?? "",
      });
    } catch (caught) {
      toast({
        title: "Could not load that product",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [productId, toast]);

  useEffect(() => {
    if (!open) return;
    setEditingVariant(null);
    setVariantForm(emptyVariant());
    if (creating) {
      setProduct(null);
      setForm({
        product_name: "",
        summary: "",
        description: "",
        status: "draft",
        is_featured: false,
        category_id: "",
        brand_name: "",
      });
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, productId]);

  useEffect(() => {
    if (!open || categories.length) return;
    void (async () => {
      try {
        const result = await api<{ items: Category[] }>("/catalog/categories");
        setCategories(result.items ?? []);
      } catch {
        // The picker is optional; a product can be filed later.
      }
    })();
  }, [open, categories.length]);

  async function run<T>(
    action: () => Promise<T>,
    success: { title: string; description?: string },
    failure: string,
  ) {
    setWorking(true);
    try {
      const result = await action();
      toast(success);
      await onChanged();
      return result;
    } catch (caught) {
      toast({
        title: failure,
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
      return null;
    } finally {
      setWorking(false);
    }
  }

  async function saveProduct(event: React.FormEvent) {
    event.preventDefault();
    const body = {
      product_name: form.product_name.trim(),
      summary: form.summary.trim() || undefined,
      description: form.description.trim() || undefined,
      status: form.status,
      is_featured: form.is_featured,
      category_id: form.category_id ? Number(form.category_id) : null,
    };

    if (creating) {
      const result = await run(
        () =>
          api<{ product: AdminProductDetail }>("/admin/products", {
            method: "POST",
            body: { ...body, brand_name: form.brand_name.trim() || undefined },
          }),
        {
          title: "Product created",
          description: `${body.product_name} was added as ${body.status}.`,
        },
        "Could not create the product",
      );
      if (result) {
        setProduct(result.product);
        setForm((current) => ({
          ...current,
          brand_name: result.product.brand_name ?? "",
        }));
      }
      return;
    }

    const result = await run(
      () =>
        api<{ product: AdminProductDetail }>(`/admin/products/${productId}`, {
          method: "PATCH",
          body,
        }),
      {
        title: "Product saved",
        description: `${body.product_name} · ${body.status}${body.is_featured ? " · featured" : ""}`,
      },
      "Could not save the product",
    );
    if (result) setProduct(result.product);
  }

  async function toggleFeatured() {
    if (!product) return;
    const next = !product.is_featured;
    const result = await run(
      () =>
        api<{ product: AdminProductDetail }>(
          `/admin/products/${product.product_id}`,
          { method: "PATCH", body: { is_featured: next } },
        ),
      {
        title: next
          ? "Featured on the front page"
          : "Removed from the front page",
        description: next
          ? `${product.product_name} now leads the landing page.`
          : undefined,
      },
      "Could not change the feature flag",
    );
    if (result) {
      setProduct(result.product);
      setForm((current) => ({
        ...current,
        is_featured: result.product.is_featured,
      }));
    }
  }

  async function setStatus(status: AdminProductDetail["status"]) {
    if (!product) return;
    const result = await run(
      () =>
        api<{ product: AdminProductDetail }>(
          `/admin/products/${product.product_id}`,
          { method: "PATCH", body: { status } },
        ),
      { title: `Product ${status === "active" ? "published" : status}` },
      "Could not change the publish state",
    );
    if (result) {
      setProduct(result.product);
      setForm((current) => ({ ...current, status: result.product.status }));
    }
  }

  async function toggleVariant(variant: AdminVariant) {
    const result = await run(
      () =>
        api<{ variant: AdminVariant }>(
          `/admin/variants/${variant.variant_id}`,
          { method: "PATCH", body: { is_active: !variant.is_active } },
        ),
      {
        title: variant.is_active
          ? `${variant.sku} unpublished`
          : `${variant.sku} published`,
      },
      "Could not change the variant",
    );
    if (result) {
      await load();
    }
  }

  async function saveVariant(event: React.FormEvent) {
    event.preventDefault();
    if (!product) return;
    const body: Record<string, unknown> = {
      sku: variantForm.sku.trim(),
      price: variantForm.price.trim(),
      qty_in_stock: Number(variantForm.qty_in_stock),
      is_active: variantForm.is_active,
    };
    if (variantForm.compare_at_price.trim())
      body.compare_at_price = variantForm.compare_at_price.trim();
    if (variantForm.option_name.trim() && variantForm.option_value.trim()) {
      body.options = [
        {
          option: variantForm.option_name.trim(),
          value: variantForm.option_value.trim(),
        },
      ];
    }

    const result = await run(
      () =>
        editingVariant === "new"
          ? api(`/admin/products/${product.product_id}/variants`, {
              method: "POST",
              body,
            })
          : api(`/admin/variants/${editingVariant}`, { method: "PATCH", body }),
      {
        title: editingVariant === "new" ? "Variant added" : "Variant saved",
        description: variantForm.sku,
      },
      "Could not save the variant",
    );
    if (result) {
      setEditingVariant(null);
      setVariantForm(emptyVariant());
      await load();
    }
  }

  const activeVariants =
    product?.variants.filter((variant) => variant.is_active).length ?? 0;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      variant="sheet"
      title={
        creating && !product
          ? "New product"
          : (product?.product_name ?? "Product")
      }
      description={
        creating && !product
          ? "The storefront shows it once it is published."
          : product
            ? `/${product.slug} · ${activeVariants} active variant${activeVariants === 1 ? "" : "s"}`
            : undefined
      }
      footer={
        <div
          className="row"
          style={{ justifyContent: "space-between", width: "100%", gap: 10 }}
        >
          <span className="muted tiny">
            {product ? `Updated ${when(product.updated_at)}` : "Not saved yet"}
          </span>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost sm" type="button" onClick={onClose}>
              Close
            </button>
            <button
              className="btn primary sm"
              type="submit"
              form="product-form"
              disabled={working}
            >
              {working
                ? "Saving…"
                : creating && !product
                  ? "Create product"
                  : "Save product"}
            </button>
          </div>
        </div>
      }
    >
      {loading ? (
        <p className="muted small">Loading the product…</p>
      ) : (
        <>
          <form
            id="product-form"
            className="stack"
            onSubmit={saveProduct}
            style={{ gap: 12 }}
          >
            <div className="field">
              <label htmlFor="product-name">Name</label>
              <input
                id="product-name"
                required
                minLength={2}
                value={form.product_name}
                onChange={(event) =>
                  setForm({ ...form, product_name: event.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="product-summary">Summary</label>
              <input
                id="product-summary"
                maxLength={400}
                placeholder="One line shown on the product tile"
                value={form.summary}
                onChange={(event) =>
                  setForm({ ...form, summary: event.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="product-description">Description</label>
              <textarea
                id="product-description"
                rows={4}
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
              />
            </div>
            <div className="row" style={{ gap: 12 }}>
              <div className="field">
                <label htmlFor="product-status">Publish state</label>
                <select
                  id="product-status"
                  value={form.status}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      status: event.target.value as typeof form.status,
                    })
                  }
                >
                  <option value="draft">Draft — hidden</option>
                  <option value="active">Published — on the shop</option>
                  <option value="archived">Archived — retired</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="product-category">Category</label>
                <select
                  id="product-category"
                  value={form.category_id}
                  onChange={(event) =>
                    setForm({ ...form, category_id: event.target.value })
                  }
                >
                  <option value="">Unfiled</option>
                  {categories.map((category) => (
                    <option
                      key={category.category_id}
                      value={category.category_id}
                    >
                      {category.category_name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {creating && !product ? (
              <div className="field">
                <label htmlFor="product-brand">Brand (optional)</label>
                <input
                  id="product-brand"
                  maxLength={100}
                  placeholder="e.g. Duka Home"
                  value={form.brand_name}
                  onChange={(event) =>
                    setForm({ ...form, brand_name: event.target.value })
                  }
                />
              </div>
            ) : null}
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.is_featured}
                onChange={(event) =>
                  setForm({ ...form, is_featured: event.target.checked })
                }
              />
              <span>
                Feature on the landing page
                <span className="muted tiny">
                  {" "}
                  — leads the front page with the other featured products.
                </span>
              </span>
            </label>
          </form>

          {creating && !product ? (
            <p className="muted small" style={{ marginTop: 14 }}>
              Save the product first, then add its variants. A product needs at
              least one active variant before it can be published.
            </p>
          ) : product ? (
            <section style={{ marginTop: 18 }}>
              <div className="shop-section-head" style={{ marginTop: 0 }}>
                <div>
                  <h4 style={{ margin: 0 }}>Variants</h4>
                  <p className="muted tiny" style={{ margin: "3px 0 0" }}>
                    Price and stock per SKU. Unpublished variants disappear from
                    the shop but stay on past orders.
                  </p>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="btn outline sm"
                    type="button"
                    disabled={working || product.status === "active"}
                    onClick={() => setStatus("active")}
                  >
                    Publish product
                  </button>
                  <button
                    className="btn ghost sm"
                    type="button"
                    disabled={working || product.status === "draft"}
                    onClick={() => setStatus("draft")}
                  >
                    Unpublish
                  </button>
                  <button
                    className="btn secondary sm"
                    type="button"
                    disabled={working}
                    onClick={toggleFeatured}
                  >
                    {product.is_featured ? "Unfeature" : "Feature"}
                  </button>
                </div>
              </div>

              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Options</th>
                      <th className="num">Price</th>
                      <th className="num">Stock</th>
                      <th className="num">Available</th>
                      <th>State</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {product.variants.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="muted small">
                          No variants yet. Add the first one below.
                        </td>
                      </tr>
                    ) : (
                      product.variants.map((variant) => (
                        <tr key={variant.variant_id}>
                          <td>
                            <strong className="mono">{variant.sku}</strong>
                            {variant.is_default ? (
                              <span className="badge outline"> default</span>
                            ) : null}
                          </td>
                          <td className="muted small">
                            {variant.options
                              .map(
                                (option) => `${option.option}: ${option.value}`,
                              )
                              .join(" · ") || "—"}
                          </td>
                          <td className="num price">
                            {variant.price}
                            {variant.compare_at_price ? (
                              <span className="muted tiny">
                                {" "}
                                was {variant.compare_at_price}
                              </span>
                            ) : null}
                          </td>
                          <td className="num">{variant.qty_in_stock}</td>
                          <td className="num">{variant.available}</td>
                          <td>
                            <Status
                              value={variant.is_active ? "active" : "draft"}
                            />
                          </td>
                          <td className="num">
                            <span className="row-actions">
                              <button
                                className="btn ghost sm"
                                type="button"
                                disabled={working}
                                onClick={() => {
                                  setEditingVariant(variant.variant_id);
                                  setVariantForm(fromVariant(variant));
                                }}
                              >
                                Edit
                              </button>
                              <button
                                className="btn outline sm"
                                type="button"
                                disabled={working}
                                onClick={() => toggleVariant(variant)}
                              >
                                {variant.is_active ? "Unpublish" : "Publish"}
                              </button>
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {editingVariant === null ? (
                <button
                  className="btn secondary sm"
                  type="button"
                  style={{ marginTop: 10 }}
                  onClick={() => {
                    setEditingVariant("new");
                    setVariantForm(emptyVariant());
                  }}
                >
                  Add a variant
                </button>
              ) : (
                <form className="variant-form" onSubmit={saveVariant}>
                  <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                    <div className="field">
                      <label htmlFor="variant-sku">SKU</label>
                      <input
                        id="variant-sku"
                        required
                        value={variantForm.sku}
                        onChange={(event) =>
                          setVariantForm({
                            ...variantForm,
                            sku: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="variant-price">Price</label>
                      <input
                        id="variant-price"
                        required
                        inputMode="decimal"
                        placeholder="1250.00"
                        value={variantForm.price}
                        onChange={(event) =>
                          setVariantForm({
                            ...variantForm,
                            price: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="variant-stock">Stock on hand</label>
                      <input
                        id="variant-stock"
                        inputMode="numeric"
                        value={variantForm.qty_in_stock}
                        onChange={(event) =>
                          setVariantForm({
                            ...variantForm,
                            qty_in_stock: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="variant-compare">
                        Compare-at (optional)
                      </label>
                      <input
                        id="variant-compare"
                        inputMode="decimal"
                        value={variantForm.compare_at_price}
                        onChange={(event) =>
                          setVariantForm({
                            ...variantForm,
                            compare_at_price: event.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                    <div className="field">
                      <label htmlFor="variant-option">Option name</label>
                      <input
                        id="variant-option"
                        placeholder="Size"
                        value={variantForm.option_name}
                        onChange={(event) =>
                          setVariantForm({
                            ...variantForm,
                            option_name: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="variant-value">Option value</label>
                      <input
                        id="variant-value"
                        placeholder="M"
                        value={variantForm.option_value}
                        onChange={(event) =>
                          setVariantForm({
                            ...variantForm,
                            option_value: event.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={variantForm.is_active}
                      onChange={(event) =>
                        setVariantForm({
                          ...variantForm,
                          is_active: event.target.checked,
                        })
                      }
                    />
                    <span>Published on the shop</span>
                  </label>
                  <div className="row" style={{ gap: 8, marginTop: 10 }}>
                    <button
                      className="btn primary sm"
                      type="submit"
                      disabled={working}
                    >
                      {working
                        ? "Saving…"
                        : editingVariant === "new"
                          ? "Add variant"
                          : "Save variant"}
                    </button>
                    <button
                      className="btn ghost sm"
                      type="button"
                      onClick={() => {
                        setEditingVariant(null);
                        setVariantForm(emptyVariant());
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </section>
          ) : null}
        </>
      )}
    </Overlay>
  );
}
