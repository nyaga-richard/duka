"use client";
import React, { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  PenLine,
  Check,
  History,
  Boxes,
  Barcode,
  Layers,
  Package,
  Tag,
  ImagePlus,
  Coins,
  CircleDollarSign,
  Percent,
  TriangleAlert,
} from "lucide-react";
import {
  api,
  useWorkspace,
  currency,
  number,
  dateText,
  D,
  useQuery,
  download,
} from "../lib";
import {
  Button,
  Badge,
  PageHeading,
  DataTable,
  Pagination,
  SearchSelect,
  Dialog,
  ErrorCard,
  Fields,
  FormField,
  LineEditor,
  StatTile,
  type FieldDef,
} from "../ui";
import { useAction, save, clean } from "./common";

export function productFields(meta: any): FieldDef[] {
  return [
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
}

/** Full-page product profile: identity and edit form, append-only stock
 * movement ledger, price change history and inline configuration actions. */
export function ProductDetailPage({ id }: { id: string }) {
  const { meta, actor, notify } = useWorkspace();
  const canWrite = actor.permissions.includes("catalog.write");
  const canReadInventory = actor.permissions.includes("inventory.read");
  const product = useQuery<any>("/products/" + id);
  const attachments = useQuery<any>(`/products/${id}/attachments`);
  const [editing, setEditing] = useState(false),
    [form, setForm] = useState<any>({}),
    [image, setImage] = useState<File | null>(null);
  const [movePage, setMovePage] = useState(1),
    [moveWarehouse, setMoveWarehouse] = useState(""),
    [moveDates, setMoveDates] = useState({ from: "", to: "" });
  const moveQuery =
    `/inventory/movements?product_id=${id}&limit=25&page=${movePage}` +
    (moveWarehouse ? `&warehouse_id=${moveWarehouse}` : "") +
    (moveDates.from ? `&from=${moveDates.from}` : "") +
    (moveDates.to ? `&to=${moveDates.to}` : "");
  const movements = useQuery<any>(canReadInventory ? moveQuery : null);
  const [changePage, setChangePage] = useState(1);
  const changes = useQuery<any>(
    `/price-changes?product_id=${id}&limit=10&page=${changePage}`,
  );
  const [priceForm, setPriceForm] = useState({ price: "", reason: "" });
  const [advanced, setAdvanced] = useState("");
  const [advancedForm, setAdvancedForm] = useState<any>({});
  const [recipe, setRecipe] = useState<any[]>([]);
  const p = product.data;
  const fields = productFields(meta);
  const edit = useAction(async () => {
    setEditing(false);
    product.refresh();
  });
  const priceAction = useAction(async () => {
    setPriceForm({ price: "", reason: "" });
    product.refresh();
    changes.refresh();
  });
  const advancedAction = useAction(async () => {
    setAdvanced("");
    setAdvancedForm({});
    product.refresh();
  });
  function beginEdit() {
    edit.setError(null);
    setImage(null);
    setEditing(true);
    setForm(
      p ? Object.fromEntries(fields.map((f) => [f.key, p[f.key] ?? ""])) : {},
    );
  }
  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    await edit.run(async () => {
      const saved: any = await save("/products", clean(form), id);
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
            record_id: id,
            filename: image.name,
            mime_type: image.type,
            base64: b64,
          },
        });
      }
      return saved;
    }, "Product updated.");
  }
  async function applyPrice(e: React.FormEvent) {
    e.preventDefault();
    await priceAction.run(
      () =>
        api("/products/bulk-prices", {
          method: "POST",
          body: {
            reason: priceForm.reason.trim(),
            prices: [{ product_id: id, price: D(priceForm.price).toFixed(2) }],
          },
        }),
      "Selling price updated.",
    );
  }
  const delta =
    p && priceForm.price.trim() !== ""
      ? (() => {
          try {
            return D(priceForm.price).minus(p.price);
          } catch {
            return undefined;
          }
        })()
      : undefined;
  return (
    <>
      <PageHeading
        eyebrow="CATALOG · PRODUCT"
        title={p?.name ?? "Product"}
        description={`${p?.sku ?? ""} · ${p?.kind ?? ""}`}
      >
        <Link href="/products" className="btn ghost">
          <ArrowLeft size={16} /> All products
        </Link>
        {canWrite && p && !editing && (
          <Button variant="secondary" onClick={beginEdit}>
            <PenLine size={16} /> Edit product
          </Button>
        )}
      </PageHeading>
      {product.error && (
        <ErrorCard error={product.error} retry={product.refresh} />
      )}
      {p && !editing && (
        <section className="card detail-header">
          <div className="stat-list">
            <StatTile
              icon={Tag}
              label="Selling price"
              value={currency(p.price, meta.company.currency)}
            />
            <StatTile
              icon={Coins}
              label="Default cost"
              value={
                p.purchase_cost === undefined
                  ? "Restricted"
                  : currency(p.purchase_cost, meta.company.currency)
              }
            />
            {p.average_cost !== undefined && (
              <StatTile
                icon={CircleDollarSign}
                label="Average cost"
                value={currency(p.average_cost, meta.company.currency)}
              />
            )}
            <StatTile
              icon={Barcode}
              label="Barcode"
              value={p.barcode ?? "None"}
            />
            <StatTile
              icon={Percent}
              label="Tax"
              value={
                (p.tax_rate == null ? "—" : D(p.tax_rate).toString()) + "%"
              }
              sub={p.tax_inclusive ? "Price includes tax" : "Tax added at sale"}
            />
            <StatTile
              icon={Boxes}
              tone={
                Number(p.stock) <= Number(p.reorder_level) ? "warn" : undefined
              }
              label="Stock on hand"
              value={`${number(p.stock)}${p.unit ? ` ${p.unit}` : ""}`}
              sub={`${number(p.reserved ?? 0)} reserved`}
            />
            <StatTile
              icon={TriangleAlert}
              label="Reorder level"
              value={`${number(p.reorder_level)}${p.unit ? ` ${p.unit}` : ""}`}
            />
            <StatTile
              label="Status"
              value={
                <Badge status={p.active ? "active" : "inactive"}>
                  {p.active ? "Active" : "Inactive"}
                </Badge>
              }
            />
          </div>
          {p.description && <p className="muted">{p.description}</p>}
          {canWrite && (
            <div className="action-grid">
              <Button
                variant="secondary"
                onClick={() => {
                  setAdvanced("barcode");
                  setAdvancedForm({ barcode: "" });
                  advancedAction.setError(null);
                }}
              >
                <Barcode size={16} /> Add barcode
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setAdvanced("unit");
                  setAdvancedForm({ unit_id: "", factor: "1" });
                  advancedAction.setError(null);
                }}
              >
                <Layers size={16} /> Unit conversion
              </Button>
              {p.kind === "bundle" && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAdvanced("recipe");
                    setRecipe([]);
                    advancedAction.setError(null);
                  }}
                >
                  <Package size={16} /> Bundle recipe
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => {
                  setAdvanced("tier");
                  setAdvancedForm({
                    price_list_id: meta.price_lists[0]?.id,
                    price: p.price,
                    min_quantity: "1",
                  });
                  advancedAction.setError(null);
                }}
              >
                Price list tier
              </Button>
            </div>
          )}
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
        </section>
      )}
      {p && editing && (
        <section className="card">
          <h3>
            <PenLine size={16} /> Edit product details
          </h3>
          <form onSubmit={submitEdit}>
            {edit.error && <ErrorCard error={edit.error} />}
            <Fields fields={fields} value={form} onChange={setForm} />
            <FormField label="Product image (optional)">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setImage(e.target.files?.[0] ?? null)}
              />
            </FormField>
            <div className="form-actions">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button busy={edit.busy} type="submit">
                <Check size={16} /> Save changes
              </Button>
            </div>
          </form>
        </section>
      )}
      {canReadInventory && (
        <section className="card">
          <div className="table-toolbar">
            <h3>
              <Boxes size={17} /> Stock movement ledger
            </h3>
            <div className="toolbar-filters">
              <select
                aria-label="Warehouse filter"
                value={moveWarehouse}
                onChange={(e) => {
                  setMoveWarehouse(e.target.value);
                  setMovePage(1);
                }}
              >
                <option value="">All assigned locations</option>
                {meta.warehouses.map((w: any) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <div className="date-filter">
                <input
                  type="date"
                  aria-label="Movements from"
                  value={moveDates.from}
                  onChange={(e) =>
                    setMoveDates({ ...moveDates, from: e.target.value })
                  }
                />
                <span>to</span>
                <input
                  type="date"
                  aria-label="Movements to"
                  value={moveDates.to}
                  onChange={(e) =>
                    setMoveDates({ ...moveDates, to: e.target.value })
                  }
                />
              </div>
            </div>
          </div>
          <p className="form-note">
            Append-only ledger of every stock movement for this item —
            purchases, sales, returns, adjustments, transfers and counts.
          </p>
          {movements.error && <ErrorCard error={movements.error} />}
          <DataTable
            loading={movements.loading}
            items={movements.data?.items}
            columns={[
              {
                key: "created_at",
                title: "Captured",
                render: (r) => dateText(r.created_at, true),
              },
              { key: "type", title: "Type" },
              { key: "warehouse", title: "Location" },
              {
                key: "quantity",
                title: "Quantity",
                align: "right",
                render: (r) =>
                  D(r.quantity).gt(0)
                    ? `+${number(r.quantity)}`
                    : number(r.quantity),
              },
              {
                key: "cost",
                title: "Avg cost",
                align: "right",
                render: (r) => currency(r.cost, meta.company.currency),
              },
              { key: "reason", title: "Reason" },
              { key: "actor", title: "By" },
            ]}
          />
          <Pagination
            page={movePage}
            total={movements.data?.total ?? 0}
            onChange={setMovePage}
          />
        </section>
      )}
      <div className="two-col">
        <section className="card">
          <h3>
            <Tag size={17} /> Change selling price
          </h3>
          <form onSubmit={applyPrice}>
            {priceAction.error && <ErrorCard error={priceAction.error} />}
            {p && (
              <div className="price-trio">
                <div className="price-current">
                  <span>Current price</span>
                  <strong>{currency(p.price, meta.company.currency)}</strong>
                </div>
                <ArrowRight size={18} className="price-arrow" aria-hidden />
                <div className="price-input">
                  <FormField label="New selling price" required>
                    <input
                      inputMode="decimal"
                      required
                      disabled={!canWrite}
                      value={priceForm.price}
                      placeholder={p.price}
                      onChange={(e) =>
                        setPriceForm({ ...priceForm, price: e.target.value })
                      }
                    />
                  </FormField>
                </div>
                {delta !== undefined && (
                  <span
                    className={"delta-chip " + (delta.isNeg() ? "down" : "up")}
                    aria-live="polite"
                  >
                    {delta.gt(0) ? "+" : ""}
                    {currency(delta, meta.company.currency)}
                  </span>
                )}
              </div>
            )}
            <FormField label="Reason" required>
              <input
                value={priceForm.reason}
                required
                minLength={5}
                disabled={!canWrite}
                placeholder="Why is the price changing?"
                onChange={(e) =>
                  setPriceForm({ ...priceForm, reason: e.target.value })
                }
              />
            </FormField>
            {canWrite && (
              <div className="form-actions">
                <Button
                  type="submit"
                  busy={priceAction.busy}
                  disabled={
                    priceForm.reason.trim().length < 5 ||
                    priceForm.price.trim() === ""
                  }
                >
                  <Check size={16} /> Apply price change
                </Button>
              </div>
            )}
            <p className="form-note">
              Applies immediately at every till. Posted sales keep their prices;
              returns value goods at the price they were sold at.
            </p>
          </form>
        </section>
        <section className="card">
          <h3>
            <History size={17} /> Price change history
          </h3>
          {changes.error && <ErrorCard error={changes.error} />}
          <DataTable
            loading={changes.loading}
            items={changes.data?.items}
            empty="No recorded selling price changes yet."
            columns={[
              {
                key: "created_at",
                title: "Changed",
                render: (r) => dateText(r.created_at, true),
              },
              {
                key: "delta",
                title: "From → To",
                align: "right",
                render: (r: any) => {
                  const d = D(r.new_price).minus(r.old_price);
                  return (
                    <span>
                      {currency(r.old_price, meta.company.currency)}
                      {" → "}
                      <strong
                        className={d.isNeg() ? "danger-text" : "success-text"}
                      >
                        {currency(r.new_price, meta.company.currency)}
                      </strong>
                    </span>
                  );
                },
              },
              { key: "actor", title: "By" },
              { key: "reason", title: "Reason" },
            ]}
          />
          <Pagination
            page={changePage}
            total={changes.data?.total ?? 0}
            onChange={setChangePage}
          />
          <p className="form-note">
            Batch changes across products:{" "}
            <Link href="/price-changes">open the price change workbench</Link>.
          </p>
        </section>
      </div>
      <Dialog
        open={!!advanced}
        onClose={() => setAdvanced("")}
        title={
          advanced === "recipe"
            ? "Bundle recipe"
            : advanced === "unit"
              ? "Unit conversion"
              : advanced === "tier"
                ? "Quantity-tier pricing"
                : "Additional barcode"
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            advancedAction.run(() =>
              advanced === "barcode"
                ? api(`/products/${id}/barcodes`, {
                    method: "POST",
                    body: advancedForm,
                  })
                : advanced === "unit"
                  ? api(`/products/${id}/units`, {
                      method: "POST",
                      body: advancedForm,
                    })
                  : advanced === "recipe"
                    ? api(`/products/${id}/components`, {
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
                        body: { product_id: id, ...advancedForm },
                      }),
            );
          }}
        >
          {advancedAction.error && <ErrorCard error={advancedAction.error} />}
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
            <Button busy={advancedAction.busy} type="submit">
              Save configuration
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
