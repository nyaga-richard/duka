"use client";
import React, { useState } from "react";
import {
  Plus,
  ArrowDownToLine,
  Upload,
  Package,
  PenLine,
  Barcode,
  Layers,
  ImagePlus,
  Check,
  History,
  Tag,
  Trash2,
  ArrowRight,
} from "lucide-react";
import {
  api,
  useWorkspace,
  currency,
  number,
  dateText,
  D,
  download,
  useQuery,
} from "../lib";
import {
  Button,
  Badge,
  PageHeading,
  DataTable,
  Pagination,
  SearchBox,
  Dialog,
  ErrorCard,
  Fields,
  FormField,
  ProductAvatar,
  SearchSelect,
  LineEditor,
  type FieldDef,
} from "../ui";
import { useList, useAction, save, clean, parseCsv } from "./common";
export function CatalogPage() {
  const { meta, actor, notify } = useWorkspace(),
    list = useList("/products", { active: "all" });
  const canWrite = actor.permissions.includes("catalog.write");
  const [editing, setEditing] = useState<any>(null),
    [form, setForm] = useState<any>({}),
    [importing, setImporting] = useState(false),
    [csv, setCsv] = useState(""),
    [detail, setDetail] = useState<any>(null),
    [detailPage, setDetailPage] = useState(1),
    [tab, setTab] = useState<"catalog" | "prices">("catalog"),
    [priceSeed, setPriceSeed] = useState<any>(null),
    [priceSeedKey, setPriceSeedKey] = useState(0),
    [advanced, setAdvanced] = useState(""),
    [advancedForm, setAdvancedForm] = useState<any>({}),
    [recipe, setRecipe] = useState<any[]>([]),
    [image, setImage] = useState<File | null>(null);
  const attachments = useQuery<any>(
    detail ? "/products/" + detail.id + "/attachments" : null,
  );
  const canReadInventory = actor.permissions.includes("inventory.read");
  const movements = useQuery<any>(
    detail && canReadInventory
      ? `/inventory/movements?product_id=${detail.id}&limit=10&page=${detailPage}`
      : null,
  );
  const prodChanges = useQuery<any>(
    detail ? `/price-changes?product_id=${detail.id}&limit=5` : null,
  );
  function beginPriceChange(p: any) {
    setPriceSeed({ product_id: p.id, price: p.price });
    setPriceSeedKey((k) => k + 1);
    setDetail(null);
    setTab("prices");
  }
  const action = useAction(async () => {
    setEditing(null);
    setImporting(false);
    list.refresh();
  });
  const extra = useAction(async () => {
    setAdvanced("");
    list.refresh();
  });
  const fields: FieldDef[] = [
    { key: "name", label: "Product name", required: true, full: true },
    { key: "sku", label: "SKU", required: true },
    { key: "barcode", label: "Primary barcode" },
    {
      key: "kind",
      label: "Product type",
      type: "select",
      options: [
        { id: "stock", name: "Physical stock" },
        { id: "service", name: "Service" },
        { id: "bundle", name: "Bundle / kit" },
      ],
      required: true,
    },
    {
      key: "category_id",
      label: "Category",
      type: "select",
      options: meta.categories,
    },
    {
      key: "unit_id",
      label: "Base unit",
      type: "select",
      options: meta.units,
      required: true,
    },
    {
      key: "tax_rule_id",
      label: "Tax category (versioned)",
      type: "select",
      options: meta.tax_rules.filter((t: any) => t.active),
      required: true,
    },
    { key: "price", label: "Selling price", type: "number", required: true },
    {
      key: "purchase_cost",
      label: "Default purchase cost",
      type: "number",
      step: "0.000001",
      required: true,
    },
    { key: "min_price", label: "Minimum authorized price", type: "number" },
    {
      key: "reorder_level",
      label: "Reorder level",
      type: "number",
      step: "0.000001",
    },
    {
      key: "max_stock",
      label: "Maximum stock level",
      type: "number",
      step: "0.000001",
    },
    { key: "brand", label: "Brand" },
    { key: "manufacturer", label: "Manufacturer" },
    { key: "description", label: "Description", type: "textarea", full: true },
    { key: "tax_inclusive", label: "Price includes tax", type: "checkbox" },
    { key: "batch_tracked", label: "Batch tracking", type: "checkbox" },
    { key: "expiry_tracked", label: "Expiry tracking", type: "checkbox" },
    {
      key: "serial_tracked",
      label: "Serial-number tracking",
      type: "checkbox",
    },
    { key: "active", label: "Product active", type: "checkbox" },
  ];
  function edit(p?: any) {
    action.setError(null);
    setImage(null);
    setEditing(p ?? {});
    const base = p
      ? Object.fromEntries(fields.map((f) => [f.key, p[f.key] ?? ""]))
      : {
          name: "",
          sku: "",
          barcode: "",
          kind: "stock",
          price: "0",
          purchase_cost: "0",
          min_price: "0",
          reorder_level: "0",
          unit_id: meta.units.find((u: any) => u.symbol === "pc")?.id,
          tax_rule_id: meta.tax_rules.find((t: any) => t.code === "VAT16")?.id,
          tax_inclusive: true,
          batch_tracked: false,
          serial_tracked: false,
          expiry_tracked: false,
          active: true,
        };
    setForm({
      ...base,
      parent_id: p?.parent_id ?? undefined,
      supplier_id: p?.supplier_id ?? undefined,
    });
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const p: any = await save("/products", clean(form), editing.id);
      if (image) {
        const b64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1]);
          r.onerror = reject;
          r.readAsDataURL(image);
        });
        await api("/attachments", {
          method: "POST",
          body: {
            entity: "product",
            record_id: p.id,
            filename: image.name,
            mime_type: image.type,
            base64: b64,
          },
        });
      }
      return p;
    }, "Product saved with an audit trail.");
  }
  async function importProducts(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const rows = parseCsv(csv);
      if (rows.length > 500)
        throw new Error("Import at most 500 products at a time.");
      const products = rows.map((r) => ({
        name: r.name,
        sku: r.sku,
        barcode: r.barcode || undefined,
        price: r.price,
        purchase_cost: r.purchase_cost || "0",
        unit_id:
          r.unit_id || meta.units.find((u: any) => u.symbol === "pc")?.id,
        tax_rule_id:
          r.tax_rule_id ||
          meta.tax_rules.find((t: any) => t.code === "VAT16")?.id,
        category_id: r.category_id || undefined,
        kind: r.kind || "stock",
      }));
      return api("/products/import", { method: "POST", body: { products } });
    }, "Catalog import completed atomically.");
  }
  return (
    <>
      <PageHeading
        eyebrow="CATALOG"
        title="Products"
        description="Your products, services and prices. One reliable source of truth."
      >
        <Button
          variant="secondary"
          onClick={() =>
            download(
              "/catalog/export?" + list.query,
              "products-page.csv",
            ).catch((e) => notify(e.message, "error"))
          }
        >
          <ArrowDownToLine size={16} /> Export page
        </Button>
        {canWrite && (
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setImporting(true);
                action.setError(null);
              }}
            >
              <Upload size={16} /> Import
            </Button>
            <Button onClick={() => edit()}>
              <Plus size={17} /> Add product
            </Button>
          </>
        )}
      </PageHeading>
      <div className="page-tabs">
        <button
          className={tab === "catalog" ? "active" : ""}
          onClick={() => setTab("catalog")}
        >
          Catalog
        </button>
        <button
          className={tab === "prices" ? "active" : ""}
          onClick={() => setTab("prices")}
        >
          <Tag size={15} /> Price changes
        </button>
      </div>
      <PriceChangesSection
        hidden={tab !== "prices"}
        canWrite={canWrite}
        onChanged={() => list.refresh()}
        key={"pc-" + priceSeedKey}
        seed={priceSeed}
      />
      <section className="card" hidden={tab !== "catalog"}>
        <div className="table-toolbar">
          <SearchBox
            value={list.search}
            onChange={list.setSearch}
            placeholder="Search name, SKU, barcode or category…"
          />
          <span className="muted">
            {list.data?.total ?? 0} products in your catalog
          </span>
        </div>
        {list.error && <ErrorCard error={list.error} retry={list.refresh} />}
        <DataTable
          loading={list.loading}
          items={list.data?.items}
          columns={[
            {
              key: "name",
              title: "Product",
              render: (p) => (
                <button
                  className="cell-button product-cell"
                  onClick={() => setDetail(p)}
                >
                  <ProductAvatar
                    name={p.name}
                    small
                    imageAttachmentId={p.image_attachment_id}
                  />
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      {p.sku} · {p.kind}
                    </small>
                  </span>
                </button>
              ),
            },
            { key: "category", title: "Category" },
            {
              key: "price",
              title: "Selling price",
              align: "right",
              render: (p) => (
                <strong>{currency(p.price, meta.company.currency)}</strong>
              ),
            },
            {
              key: "purchase_cost",
              title: "Default cost",
              align: "right",
              render: (p) =>
                p.purchase_cost === undefined
                  ? "Restricted"
                  : currency(p.purchase_cost, meta.company.currency),
            },
            {
              key: "stock",
              title: "Available",
              align: "right",
              render: (p) =>
                p.kind === "stock" ? (
                  <span
                    className={
                      Number(p.stock) <= Number(p.reorder_level)
                        ? "warning-text"
                        : ""
                    }
                  >
                    {number(p.stock)} {p.unit}
                  </span>
                ) : p.kind === "service" ? (
                  "Service"
                ) : (
                  "Components"
                ),
            },
            {
              key: "active",
              title: "Status",
              render: (p) => (
                <Badge status={p.active ? "active" : "inactive"}>
                  {p.active ? "Active" : "Inactive"}
                </Badge>
              ),
            },
            {
              key: "action",
              title: "",
              render: (p) =>
                canWrite ? (
                  <button
                    className="icon-btn"
                    aria-label={"Edit " + p.name}
                    onClick={() => edit(p)}
                  >
                    <PenLine size={16} />
                  </button>
                ) : null,
            },
          ]}
        />
        <Pagination
          page={list.page}
          total={list.data?.total ?? 0}
          onChange={list.setPage}
        />
      </section>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? "Edit product" : "Add a product"}
        description="Prices use exact decimal values. Inventory tracking cannot change after stock history exists."
        wide
      >
        <form onSubmit={submit}>
          {action.error && <ErrorCard error={action.error} />}
          <Fields fields={fields} value={form} onChange={setForm} />
          <SearchSelect
            endpoint="/suppliers"
            label="Preferred supplier"
            value={meta._none}
            onChange={(s) => setForm({ ...form, supplier_id: s?.id })}
          />
          <SearchSelect
            endpoint="/products"
            label="Parent product (optional variant)"
            onChange={(p) => setForm({ ...form, parent_id: p?.id })}
          />
          <FormField
            label="Product image"
            help="Optional PNG or JPEG, maximum 5 MiB. Files remain access-controlled."
          >
            <input
              type="file"
              accept="image/png,image/jpeg"
              onChange={(e) => setImage(e.target.files?.[0] ?? null)}
            />
          </FormField>
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
            <Button busy={action.busy} type="submit">
              Save product
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={importing}
        onClose={() => setImporting(false)}
        title="Import products"
        description="Atomic CSV import, up to 500 rows. Duplicate SKU or barcode rejects the whole batch."
        wide
      >
        <form onSubmit={importProducts}>
          {action.error && <ErrorCard error={action.error} />}
          <p className="form-note">
            Required headers: name, sku, price. Optional: barcode,
            purchase_cost, unit_id, tax_rule_id, category_id, kind. Missing
            unit/tax IDs use Each and the configured VAT16 category; review
            before production imports.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="CSV file"
            onChange={(e) => e.target.files?.[0]?.text().then(setCsv)}
          />
          <FormField label="CSV content">
            <textarea
              rows={10}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={
                "name,sku,barcode,price,purchase_cost\nExample product,EX001,6160000001000,116,50"
              }
              required
            />
          </FormField>
          <div className="form-actions">
            <Button busy={action.busy} type="submit">
              Validate & import
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.name ?? "Product"}
        description={`${detail?.sku ?? ""} · ${detail?.kind ?? ""}`}
      >
        <div className="detail-grid">
          <div>
            <span>Retail price</span>
            <strong>{currency(detail?.price, meta.company.currency)}</strong>
          </div>
          <div>
            <span>Default cost</span>
            <strong>
              {detail?.purchase_cost === undefined
                ? "Restricted"
                : currency(detail.purchase_cost, meta.company.currency)}
            </strong>
          </div>
          <div>
            <span>Barcode</span>
            <strong>{detail?.barcode ?? "None"}</strong>
          </div>
          <div>
            <span>Tax rate</span>
            <strong>
              {detail?.tax_rate}%{" "}
              {detail?.tax_inclusive ? "inclusive" : "exclusive"}
            </strong>
          </div>
        </div>
        <div className="action-grid">
          {canWrite && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setAdvanced("barcode");
                  setAdvancedForm({ barcode: "" });
                  extra.setError(null);
                }}
              >
                <Barcode size={16} /> Add barcode
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setAdvanced("unit");
                  setAdvancedForm({ unit_id: "", factor: "1" });
                  extra.setError(null);
                }}
              >
                <Layers size={16} /> Unit conversion
              </Button>
              {detail?.kind === "bundle" && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAdvanced("recipe");
                    setRecipe([]);
                    extra.setError(null);
                  }}
                >
                  <Package size={16} /> Bundle recipe
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => {
                  setAdvanced("price");
                  setAdvancedForm({
                    price_list_id: meta.price_lists[0]?.id,
                    price: detail.price,
                    min_quantity: "1",
                  });
                  extra.setError(null);
                }}
              >
                Price list tier
              </Button>
              <Button
                variant="secondary"
                onClick={() => beginPriceChange(detail)}
              >
                <Tag size={16} /> Change selling price
              </Button>
            </>
          )}
        </div>
        {canReadInventory && (
          <div className="detail-ledger">
            <h4>
              Stock movement ledger
              <small className="muted"> · append-only, newest first</small>
            </h4>
            {movements.error && <ErrorCard error={movements.error} />}
            <DataTable
              loading={movements.loading}
              items={movements.data?.items}
              columns={[
                {
                  key: "created_at",
                  title: "Captured",
                  render: (r: any) => dateText(r.created_at, true),
                },
                { key: "type", title: "Type" },
                { key: "warehouse", title: "Location" },
                {
                  key: "quantity",
                  title: "Quantity",
                  align: "right",
                  render: (r: any) =>
                    D(r.quantity).gt(0)
                      ? `+${number(r.quantity)}`
                      : number(r.quantity),
                },
                {
                  key: "cost",
                  title: "Avg cost",
                  align: "right",
                  render: (r: any) => currency(r.cost, meta.company.currency),
                },
                { key: "actor", title: "By" },
              ]}
            />
            <Pagination
              page={detailPage}
              total={movements.data?.total ?? 0}
              onChange={setDetailPage}
            />
          </div>
        )}
        <div className="detail-ledger">
          <h4>
            <History size={15} /> Recent price changes
          </h4>
          {prodChanges.error && <ErrorCard error={prodChanges.error} />}
          <DataTable
            loading={prodChanges.loading}
            items={prodChanges.data?.items}
            empty="No recorded selling price changes yet."
            columns={[
              {
                key: "created_at",
                title: "Date",
                render: (r: any) => dateText(r.created_at, true),
              },
              {
                key: "old_price",
                title: "From",
                align: "right",
                render: (r: any) =>
                  currency(r.old_price, meta.company.currency),
              },
              {
                key: "new_price",
                title: "To",
                align: "right",
                render: (r: any) =>
                  currency(r.new_price, meta.company.currency),
              },
              { key: "actor", title: "By" },
              { key: "reason", title: "Reason" },
            ]}
          />
        </div>
        {attachments.data?.items?.map((f: any) => (
          <a
            className="attachment-link"
            key={f.id}
            href={"/api/v1/attachments/" + f.id}
            target="_blank"
            rel="noreferrer"
          >
            <ImagePlus size={18} />
            {f.filename} ({number(f.size)} bytes)
          </a>
        ))}
      </Dialog>
      <Dialog
        open={!!advanced}
        onClose={() => setAdvanced("")}
        title={
          advanced === "recipe"
            ? "Bundle recipe"
            : advanced === "unit"
              ? "Unit conversion"
              : advanced === "price"
                ? "Quantity-tier pricing"
                : "Additional barcode"
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            extra.run(() =>
              advanced === "barcode"
                ? api(`/products/${detail.id}/barcodes`, {
                    method: "POST",
                    body: advancedForm,
                  })
                : advanced === "unit"
                  ? api(`/products/${detail.id}/units`, {
                      method: "POST",
                      body: advancedForm,
                    })
                  : advanced === "recipe"
                    ? api(`/products/${detail.id}/components`, {
                        method: "POST",
                        body: {
                          components: recipe.map((l) => ({
                            product_id: l.product_id,
                            quantity: l.quantity,
                          })),
                        },
                      })
                    : api("/prices", {
                        method: "POST",
                        body: { product_id: detail.id, ...advancedForm },
                      }),
            );
          }}
        >
          {extra.error && <ErrorCard error={extra.error} />}{" "}
          {advanced === "recipe" ? (
            <LineEditor lines={recipe} onChange={setRecipe} />
          ) : (
            <Fields
              fields={
                advanced === "barcode"
                  ? [
                      {
                        key: "barcode",
                        label: "Unique barcode",
                        required: true,
                      },
                    ]
                  : advanced === "unit"
                    ? [
                        {
                          key: "unit_id",
                          label: "Alternate unit",
                          type: "select",
                          options: meta.units,
                          required: true,
                        },
                        {
                          key: "factor",
                          label: "Number of base units",
                          required: true,
                          type: "number",
                          step: "0.000001",
                        },
                      ]
                    : [
                        {
                          key: "price_list_id",
                          label: "Price list",
                          type: "select",
                          options: meta.price_lists,
                          required: true,
                        },
                        {
                          key: "price",
                          label: "Base unit price",
                          type: "number",
                          required: true,
                        },
                        {
                          key: "min_quantity",
                          label: "Minimum base quantity",
                          type: "number",
                          step: "0.000001",
                          required: true,
                        },
                      ]
              }
              value={advancedForm}
              onChange={setAdvancedForm}
            />
          )}
          <div className="form-actions">
            <Button busy={extra.busy} type="submit">
              Save configuration
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/** Price change workbench: draft one or more atomic price updates, then a
 * live history of every recorded change (who, from→to, why). */
function PriceChangesSection({
  hidden,
  canWrite,
  onChanged,
  seed,
}: {
  hidden: boolean;
  canWrite: boolean;
  onChanged: () => void;
  seed?: any;
}) {
  const { meta, notify } = useWorkspace();
  const [rows, setRows] = useState<any[]>(
    seed ? [{ ...seed, key: crypto.randomUUID() }] : [],
  );
  const [reason, setReason] = useState("");
  const [dates, setDates] = useState({ from: "", to: "" });
  const history = useList("/price-changes", {
    from: dates.from || undefined,
    to: dates.to || undefined,
  });
  const products = useQuery<any>(
    canWrite ? "/products?active=true&limit=200" : null,
  );
  const action = useAction(async () => {
    setRows([]);
    setReason("");
    history.refresh();
    onChanged();
  });
  const items = products.data?.items ?? [];
  const chosen = new Set(rows.map((r) => r.product_id).filter(Boolean));
  const valid =
    reason.trim().length >= 5 &&
    rows.length > 0 &&
    rows.every((r) => r.product_id && !D(r.price || "0").isNegative());
  async function apply(e: React.FormEvent) {
    e.preventDefault();
    await action.run(
      () =>
        api("/products/bulk-prices", {
          method: "POST",
          body: {
            reason: reason.trim(),
            prices: rows.map((r) => ({
              product_id: r.product_id,
              price: D(r.price).toFixed(2),
            })),
          },
        }),
      `Applied ${rows.length} price change${rows.length === 1 ? "" : "s"} atomically.`,
    );
  }
  return (
    <div className="price-changes" hidden={hidden}>
      {canWrite && (
        <section className="card">
          <h3>
            <Tag size={17} /> Implement a price change
          </h3>
          <p className="muted">
            Updates apply immediately to every point of sale and price list
            default. Sales already posted keep their original prices — returns
            value goods at the price they were sold at.
          </p>
          {action.error && <ErrorCard error={action.error} />}
          <form onSubmit={apply}>
            <div className="price-change-rows">
              {rows.map((r, i) => (
                <div className="price-change-row" key={r.key}>
                  <select
                    aria-label={"Product for price change " + (i + 1)}
                    value={r.product_id}
                    required
                    onChange={(e) =>
                      setRows(
                        rows.map((x, j) =>
                          j === i ? { ...x, product_id: e.target.value } : x,
                        ),
                      )
                    }
                  >
                    <option value="">Select product…</option>
                    {items
                      .filter(
                        (p: any) => !chosen.has(p.id) || p.id === r.product_id,
                      )
                      .map((p: any) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.sku} ·{" "}
                          {currency(p.price, meta.company.currency)}
                        </option>
                      ))}
                  </select>
                  <input
                    aria-label={"New price " + (i + 1)}
                    inputMode="decimal"
                    placeholder="New selling price"
                    value={r.price}
                    required
                    onChange={(e) =>
                      setRows(
                        rows.map((x, j) =>
                          j === i ? { ...x, price: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={"Remove price change " + (i + 1)}
                    onClick={() => setRows(rows.filter((_x, j) => j !== i))}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setRows([
                  ...rows,
                  { product_id: "", price: "", key: crypto.randomUUID() },
                ])
              }
              disabled={items.length === 0}
            >
              <Plus size={15} /> Add product
            </Button>
            <FormField label="Reason (required)" required>
              <input
                value={reason}
                minLength={5}
                required
                placeholder="e.g. Supplier increased wholesale costs in October"
                onChange={(e) => setReason(e.target.value)}
              />
            </FormField>
            <div className="form-actions">
              <Button type="submit" busy={action.busy} disabled={!valid}>
                <Check size={16} /> Apply{" "}
                {rows.length > 1 ? rows.length + " changes" : "change"}
              </Button>
            </div>
          </form>
        </section>
      )}
      <section className="card">
        <div className="table-toolbar">
          <SearchBox
            value={history.search}
            onChange={history.setSearch}
            placeholder="Search product or SKU…"
          />
          <div className="date-filter">
            <input
              type="date"
              aria-label="Price changes from"
              value={dates.from}
              onChange={(e) => setDates({ ...dates, from: e.target.value })}
            />
            <span>to</span>
            <input
              type="date"
              aria-label="Price changes to"
              value={dates.to}
              onChange={(e) => setDates({ ...dates, to: e.target.value })}
            />
          </div>
        </div>
        {history.error && <ErrorCard error={history.error} />}
        <DataTable
          loading={history.loading}
          items={history.data?.items}
          empty="No price changes recorded in this period."
          columns={[
            {
              key: "created_at",
              title: "Changed",
              render: (r) => dateText(r.created_at, true),
            },
            {
              key: "product",
              title: "Product",
              render: (r) => (
                <span>
                  <strong>{r.product}</strong> <small>{r.sku}</small>
                </span>
              ),
            },
            {
              key: "old_price",
              title: "From",
              align: "right",
              render: (r) => currency(r.old_price, meta.company.currency),
            },
            {
              key: "new_price",
              title: "To",
              align: "right",
              render: (r) => currency(r.new_price, meta.company.currency),
            },
            {
              key: "delta",
              title: "Δ",
              align: "right",
              render: (r: any) => {
                const d = D(r.new_price).minus(r.old_price);
                return (
                  <span className={d.isNeg() ? "danger-text" : "success-text"}>
                    {d.gt(0) ? "+" : ""}
                    {currency(d, meta.company.currency)}
                  </span>
                );
              },
            },
            { key: "actor", title: "By" },
            { key: "reason", title: "Reason" },
          ]}
        />
        <Pagination
          page={history.page}
          total={history.data?.total ?? 0}
          onChange={history.setPage}
        />
      </section>
    </div>
  );
}
