"use client";
import React, { useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { Tag, Trash2, Plus, Check, History } from "lucide-react";
import { api, useWorkspace, currency, dateText, D, useQuery } from "../lib";
import {
  Button,
  PageHeading,
  DataTable,
  Pagination,
  SearchBox,
  SearchSelect,
  ErrorCard,
  FormField,
} from "../ui";
import { useList, useAction } from "./common";

/** Dedicated price-change workbench page: draft atomic price updates, then
 * review the full from→to history. Reachable at /price-changes and pre-seeded
 * from a product page via ?product=<id>. */
export function PriceChangesPage() {
  const { meta, actor } = useWorkspace();
  const canWrite = actor.permissions.includes("catalog.write");
  const params = useSearchParams();
  const seedId = params.get("product");
  const seeded = useRef(false);
  const seedProduct = useQuery<any>(seedId ? "/products/" + seedId : null);
  const [rows, setRows] = useState<any[]>([]);
  const [reason, setReason] = useState("");
  const [dates, setDates] = useState({ from: "", to: "" });
  const history = useList("/price-changes", {
    from: dates.from || undefined,
    to: dates.to || undefined,
  });
  const action = useAction(async () => {
    setRows([]);
    setReason("");
    history.refresh();
  });
  useEffect(() => {
    if (!seeded.current && seedProduct.data?.id) {
      seeded.current = true;
      setRows([
        {
          product_id: seedProduct.data.id,
          product: seedProduct.data,
          price: seedProduct.data.price,
          key: crypto.randomUUID(),
        },
      ]);
    }
  }, [seedProduct.data]);
  const priceProblem = rows.find((r) => {
    if (!r.product_id || r.price.trim() === "") return false;
    try {
      return D(r.price).isNegative();
    } catch {
      return true;
    }
  });
  const valid =
    reason.trim().length >= 5 &&
    rows.length > 0 &&
    !priceProblem &&
    rows.every((r) => r.product_id && r.price.trim() !== "");
  async function apply(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
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
    <>
      <PageHeading
        eyebrow="CATALOG · PRICING"
        title="Price changes"
        description="Implement selling price updates and track every change — who, from what to what and why."
      />
      {canWrite && (
        <section className="card price-change-form">
          <h3>
            <Tag size={17} /> Implement a price change
          </h3>
          <p className="form-note">
            Updates sell immediately at every point of sale. Sales already
            posted keep their prices — returns value goods at the price they
            were sold at.
          </p>
          {action.error && <ErrorCard error={action.error} />}
          <form onSubmit={apply}>
            {rows.map((r, i) => (
              <div className="price-change-row" key={r.key}>
                <SearchSelect
                  endpoint="/products?active=true"
                  label={"Product " + (i + 1)}
                  value={r.product}
                  display="name"
                  placeholder="Search name, SKU or barcode…"
                  onChange={(p) =>
                    setRows(
                      rows.map((x, j) =>
                        j === i
                          ? { ...x, product_id: p?.id ?? "", product: p }
                          : x,
                      ),
                    )
                  }
                />
                <div className="price-change-current">
                  {r.product ? (
                    <>
                      <span>Current</span>
                      <strong>
                        {currency(r.product.price, meta.company.currency)}
                      </strong>
                    </>
                  ) : null}
                </div>
                <FormField label="New selling price" required>
                  <input
                    inputMode="decimal"
                    placeholder="0.00"
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
                </FormField>
                {r.product && r.price.trim() !== "" && !priceProblem && (
                  <div className="price-change-delta" aria-live="polite">
                    {(() => {
                      const d = D(r.price).minus(r.product.price);
                      return (
                        <strong
                          className={d.isNeg() ? "danger-text" : "success-text"}
                        >
                          {d.gt(0) ? "+" : ""}
                          {currency(d, meta.company.currency)}
                        </strong>
                      );
                    })()}
                  </div>
                )}
                <button
                  type="button"
                  className="icon-btn remove-row"
                  aria-label={"Remove price change " + (i + 1)}
                  onClick={() => setRows(rows.filter((_x, j) => j !== i))}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            {rows.length === 0 && (
              <p className="muted empty-hint">
                Add a product below to draft its new price.
              </p>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setRows([
                  ...rows,
                  { product_id: "", price: "", key: crypto.randomUUID() },
                ])
              }
            >
              <Plus size={15} /> Add product
            </Button>
            <FormField
              label="Reason (shared by all changes in this batch)"
              required
            >
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
          <h3>
            <History size={17} /> Recorded changes
          </h3>
          <div className="toolbar-filters">
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
        </div>
        {history.error && (
          <ErrorCard error={history.error} retry={history.refresh} />
        )}
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
    </>
  );
}
