"use client";
import React, { useState } from "react";
import Link from "next/link";
import { Plus, ArrowDownToLine, Upload, PenLine } from "lucide-react";
import { api, useWorkspace, currency, number, download } from "../lib";
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
} from "../ui";
import { useList, useAction, save, clean, parseCsv } from "./common";
import { productFields } from "./product-detail";

/** Catalog list: search, CSV import/export, and quick create. Each product
 * row links to its dedicated detail page (/products/:id) carrying the full
 * profile, stock ledger and price-change controls. */
export function CatalogPage() {
  const { meta, actor, notify } = useWorkspace(),
    list = useList("/products", { active: "all" });
  const canWrite = actor.permissions.includes("catalog.write");
  const [editing, setEditing] = useState<any>(null),
    [form, setForm] = useState<any>({}),
    [importing, setImporting] = useState(false),
    [csv, setCsv] = useState(""),
    [image, setImage] = useState<File | null>(null);
  const fields = productFields(meta);
  const action = useAction(async () => {
    setEditing(null);
    setImporting(false);
    list.refresh();
  });
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
      <section className="card">
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
                <Link
                  className="cell-button product-cell"
                  href={"/products/" + p.id}
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
                </Link>
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
    </>
  );
}
