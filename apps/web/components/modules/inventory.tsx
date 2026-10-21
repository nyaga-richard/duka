"use client";
import React, { useState, useRef } from "react";
import {
  Plus,
  ArrowLeftRight,
  ClipboardCheck,
  Boxes,
  ArrowUpRight,
  Printer,
  RefreshCw,
  CheckCheck,
} from "lucide-react";
import {
  api,
  useWorkspace,
  currency,
  number,
  dateText,
  D,
  draftDecimal,
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
  LineEditor,
  ProductAvatar,
} from "../ui";
import { useList, useAction, clean } from "./common";
function TrackingFields({
  line,
  warehouseId,
  onChange,
  transfer = false,
}: {
  transfer?: boolean;
  line: any;
  warehouseId: string;
  onChange: (l: any) => void;
}) {
  const outgoing = transfer || draftDecimal(line.quantity).lt(0);
  const batches = useQuery<any>(
    line.product?.batch_tracked && outgoing
      ? `/inventory/batches?warehouse_id=${warehouseId}&product_id=${line.product_id}&limit=100`
      : null,
  );
  if (!line.product?.batch_tracked || !outgoing) return null;
  return (
    <FormField label={"Source batch for " + line.product.name} required>
      <select
        value={line.batch_id ?? ""}
        onChange={(e) => onChange({ ...line, batch_id: e.target.value })}
        required
      >
        <option value="">Select batch</option>
        {batches.data?.items?.map((b: any) => (
          <option key={b.id} value={b.id}>
            {b.batch_number} · {b.quantity} available
          </option>
        ))}
      </select>
    </FormField>
  );
}
export function InventoryPage() {
  const { meta, actor, branch, notify } = useWorkspace();
  const [tab, setTab] = useState("balances"),
    [warehouse, setWarehouse] = useState(""),
    [low, setLow] = useState(false),
    [open, setOpen] = useState(false),
    [form, setForm] = useState<any>({}),
    [lines, setLines] = useState<any[]>([]),
    [snapshotBusy, setSnapshotBusy] = useState(false),
    [reconOpen, setReconOpen] = useState(false);
  const snapshotEpoch = useRef(0);
  const invalidateSnapshot = () => {
    snapshotEpoch.current++;
    setSnapshotBusy(false);
  };
  function changeForm(value: any) {
    if (value.warehouse_id !== form.warehouse_id || value.type !== form.type) {
      invalidateSnapshot();
      setLines((rows) =>
        rows.map(({ expected_version, system_quantity, ...line }) => line),
      );
    }
    setForm(value);
  }
  function changeLines(value: any[]) {
    invalidateSnapshot();
    const existing = new Set(lines.map((l) => l.product_id));
    setLines(
      value.map((l) => {
        if (existing.has(l.product_id)) return l;
        const { expected_version, system_quantity, ...line } = l;
        return line;
      }),
    );
  }
  function closeForm() {
    invalidateSnapshot();
    setOpen(false);
  }
  const list = useList("/inventory/" + tab, {
    warehouse_id: warehouse || undefined,
    low: low ? "true" : undefined,
  });
  const recon = useQuery<any>(reconOpen ? "/inventory/reconciliation" : null);
  const action = useAction(() => {
    setOpen(false);
    list.refresh();
  });
  function begin(type: string) {
    invalidateSnapshot();
    action.setError(null);
    setLines([]);
    setForm({
      type,
      warehouse_id:
        warehouse ||
        (meta.warehouses.find((w: any) => !branch || w.branch_id === branch)
          ?.id ??
          ""),
      reason: "",
      accounting_date: new Date().toLocaleDateString("en-CA"),
    });
    setOpen(true);
  }
  async function snapshots() {
    const epoch = ++snapshotEpoch.current;
    setSnapshotBusy(true);
    try {
      const next = [];
      for (const l of lines) {
        const r: any = await api(
          `/inventory/balances?warehouse_id=${form.warehouse_id}&q=${encodeURIComponent(l.product.sku)}&limit=100`,
        );
        const b = r.items.find((v: any) => v.product_id === l.product_id);
        next.push({
          ...l,
          expected_version: Number(b?.version ?? 0),
          system_quantity: b?.quantity ?? "0",
          quantity: b?.quantity ?? "0",
        });
      }
      if (epoch !== snapshotEpoch.current) return;
      setLines(next);
      notify(
        "System quantities captured. Enter your physical count before posting.",
        "info",
      );
    } catch (e: any) {
      notify(e.message, "error");
    } finally {
      if (epoch === snapshotEpoch.current) setSnapshotBusy(false);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await action.run(
      () =>
        api("/inventory/documents", {
          method: "POST",
          body: clean({
            ...form,
            lines: lines.map((l) =>
              clean({
                product_id: l.product_id,
                quantity: l.quantity,
                ...(form.type === "opening" ||
                (form.type === "adjustment" && D(l.quantity).gt(0))
                  ? { unit_cost: l.unit_cost }
                  : {}),
                ...(l.expected_version !== undefined
                  ? { expected_version: l.expected_version }
                  : {}),
                batch_id: l.batch_id,
                batch_number: l.batch_number,
                expiry_date: l.expiry_date,
                serials: l.serials ?? [],
              }),
            ),
          }),
        }),
      "Stock document posted. The movement ledger and accounts are updated.",
    );
  }
  const columns =
    tab === "balances"
      ? [
          {
            key: "name",
            title: "Product",
            render: (r: any) => (
              <div className="product-cell">
                <ProductAvatar name={r.name} small imageAttachmentId={r.image_attachment_id} />
                <div>
                  <strong>{r.name}</strong>
                  <small>{r.sku}</small>
                </div>
              </div>
            ),
          },
          { key: "warehouse", title: "Location" },
          {
            key: "quantity",
            title: "On hand",
            align: "right" as const,
            render: (r: any) => number(r.quantity) + " " + r.unit,
          },
          {
            key: "reserved",
            title: "Reserved",
            align: "right" as const,
            render: (r: any) => number(r.reserved),
          },
          {
            key: "available",
            title: "Available",
            align: "right" as const,
            render: (r: any) => (
              <strong
                className={
                  D(r.available).lte(r.reorder_level) ? "warning-text" : ""
                }
              >
                {number(r.available)}
              </strong>
            ),
          },
          {
            key: "average_cost",
            title: "Avg. cost",
            align: "right" as const,
            render: (r: any) => currency(r.average_cost, meta.company.currency),
          },
          {
            key: "value",
            title: "Value",
            align: "right" as const,
            render: (r: any) => currency(r.value, meta.company.currency),
          },
          {
            key: "action",
            title: "",
            render: (r: any) =>
              actor.permissions.includes("inventory.count") ? (
                <button
                  className="icon-btn"
                  aria-label={"Count " + r.name}
                  onClick={() => {
                    begin("count");
                    setForm({
                      type: "count",
                      warehouse_id: r.warehouse_id,
                      reason: "Physical stock count",
                      accounting_date: new Date().toLocaleDateString("en-CA"),
                    });
                    setLines([
                      {
                        product_id: r.product_id,
                        product: { ...r, id: r.product_id },
                        quantity: r.quantity,
                        unit_cost: r.average_cost,
                        system_quantity: r.quantity,
                        expected_version: Number(r.version),
                      },
                    ]);
                  }}
                >
                  <ClipboardCheck size={16} />
                </button>
              ) : null,
          },
        ]
      : tab === "movements"
        ? [
            {
              key: "created_at",
              title: "Captured",
              render: (r: any) => dateText(r.created_at, true),
            },
            { key: "name", title: "Product" },
            { key: "warehouse", title: "Location" },
            {
              key: "type",
              title: "Movement",
              render: (r: any) => <Badge>{r.type.replaceAll("_", " ")}</Badge>,
            },
            {
              key: "quantity",
              title: "Quantity",
              align: "right" as const,
              render: (r: any) => (
                <span
                  className={
                    D(r.quantity).lt(0) ? "danger-text" : "success-text"
                  }
                >
                  {D(r.quantity).gt(0) ? "+" : ""}
                  {number(r.quantity)}
                </span>
              ),
            },
            {
              key: "value",
              title: "Value",
              align: "right" as const,
              render: (r: any) => currency(r.value, meta.company.currency),
            },
            { key: "actor", title: "Actor" },
            { key: "reason", title: "Reference / reason" },
          ]
        : tab === "batches"
          ? [
              { key: "name", title: "Product" },
              { key: "batch_number", title: "Batch" },
              { key: "warehouse", title: "Warehouse" },
              {
                key: "quantity",
                title: "Quantity",
                align: "right" as const,
                render: (r: any) => number(r.quantity),
              },
              {
                key: "expiry_date",
                title: "Expiry",
                render: (r: any) => dateText(r.expiry_date),
              },
              {
                key: "expired",
                title: "Status",
                render: (r: any) => (
                  <Badge status={r.expired ? "expired" : "active"}>
                    {r.expired ? "Expired" : "Available"}
                  </Badge>
                ),
              },
            ]
          : tab === "serials"
            ? [
                { key: "name", title: "Product" },
                { key: "serial", title: "Serial number" },
                {
                  key: "status",
                  title: "Status",
                  render: (r: any) => (
                    <Badge status={r.status}>{r.status}</Badge>
                  ),
                },
              ]
            : [
                { key: "number", title: "Document" },
                { key: "type", title: "Type" },
                { key: "warehouse", title: "Location" },
                {
                  key: "accounting_date",
                  title: "Date",
                  render: (r: any) => dateText(r.accounting_date),
                },
                { key: "reason", title: "Reason" },
                {
                  key: "print",
                  title: "",
                  render: (r: any) => (
                    <a
                      className="icon-btn"
                      aria-label="Print stock document"
                      target="_blank"
                      rel="noreferrer"
                      href={"/api/v1/print/stock-document/" + r.id}
                    >
                      <Printer size={16} />
                    </a>
                  ),
                },
              ];
  return (
    <>
      <PageHeading
        eyebrow="OPERATIONS"
        title="Inventory"
        description="Know what’s on hand, where it is, and how it got there."
      >
        {actor.permissions.includes("accounting.read") && (
          <Button
            variant="secondary"
            onClick={() => {
              setReconOpen(true);
              recon.refresh();
            }}
          >
            <CheckCheck size={16} /> Reconcile
          </Button>
        )}
        {actor.permissions.includes("inventory.transfer") && (
          <Button variant="secondary" onClick={() => begin("transfer")}>
            <ArrowLeftRight size={16} /> Transfer
          </Button>
        )}
        {actor.permissions.includes("inventory.write") && (
          <Button onClick={() => begin("adjustment")}>
            <Plus size={17} /> Stock document
          </Button>
        )}
      </PageHeading>
      <div className="page-tabs">
        {[
          ["balances", "Stock balances"],
          ["movements", "Movement ledger"],
          ["batches", "Batches & expiry"],
          ["serials", "Serial numbers"],
          ["documents", "Documents & counts"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="card">
        <div className="table-toolbar">
          <SearchBox
            value={list.search}
            onChange={list.setSearch}
            placeholder="Search product or SKU…"
          />
          <div className="toolbar-filters">
            <select
              aria-label="Warehouse filter"
              value={warehouse}
              onChange={(e) => setWarehouse(e.target.value)}
            >
              <option value="">All assigned locations</option>
              {meta.warehouses
                .filter((w: any) => !branch || w.branch_id === branch)
                .map((w: any) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
            {tab === "balances" && (
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={low}
                  onChange={(e) => setLow(e.target.checked)}
                />{" "}
                Low stock only
              </label>
            )}
          </div>
        </div>
        {list.error && <ErrorCard error={list.error} />}
        <DataTable
          columns={columns}
          items={list.data?.items}
          loading={list.loading}
        />
        <Pagination
          page={list.page}
          total={list.data?.total ?? 0}
          onChange={list.setPage}
        />
      </section>
      <Dialog
        open={open}
        onClose={closeForm}
        title={
          form.type === "transfer"
            ? "Transfer stock"
            : form.type === "count"
              ? "Physical stock count"
              : "Post stock document"
        }
        description="Stock and accounting changes commit together. Weighted-average movements cannot precede later stock history."
        wide
      >
        <form onSubmit={submit}>
          {action.error && <ErrorCard error={action.error} />}
          <Fields
            fields={[
              {
                key: "type",
                label: "Document type",
                type: "select",
                required: true,
                options: [
                  {
                    id: "opening",
                    name: "Opening stock — no existing history",
                  },
                  {
                    id: "adjustment",
                    name: "Adjustment — signed quantity change",
                  },
                  { id: "transfer", name: "Warehouse / branch transfer" },
                  {
                    id: "count",
                    name: "Stock count — actual counted quantity",
                  },
                ],
              },
              {
                key: "warehouse_id",
                label:
                  form.type === "transfer" ? "Source warehouse" : "Warehouse",
                type: "select",
                required: true,
                options: meta.warehouses,
              },
              ...(form.type === "transfer"
                ? [
                    {
                      key: "destination_id",
                      label: "Destination warehouse",
                      type: "select",
                      required: true,
                      options: meta.warehouses.filter(
                        (w: any) => w.id !== form.warehouse_id,
                      ),
                    },
                  ]
                : []),
              {
                key: "accounting_date",
                label: "Accounting date",
                type: "date",
                required: true,
              },
              {
                key: "reason",
                label: "Reason",
                type: "textarea",
                required: true,
                full: true,
              },
            ]}
            value={form}
            onChange={changeForm}
          />
          <LineEditor
            lines={lines}
            onChange={changeLines}
            costMode={form.type === "opening" || form.type === "adjustment"}
            stockMode
            outgoing={form.type === "transfer"}
          />
          {lines.map((l, i) => (
            <TrackingFields
              key={i}
              line={l}
              transfer={form.type === "transfer"}
              warehouseId={form.warehouse_id}
              onChange={(v) => setLines(lines.map((x, j) => (i === j ? v : x)))}
            />
          ))}
          {form.type === "count" && (
            <>
              <Button
                type="button"
                variant="secondary"
                busy={snapshotBusy}
                onClick={snapshots}
              >
                <RefreshCw size={16} /> Load current system quantities
              </Button>
              <p className="form-note">
                After loading the system snapshot, replace quantities with your
                actual counted quantities. Any intervening stock movement causes
                a conflict, never a silent overwrite.
              </p>
              {lines.map((l, i) => (
                <p className="snapshot-note" key={i}>
                  {l.product?.name}: system{" "}
                  {l.system_quantity ?? "not captured"} · version{" "}
                  {l.expected_version ?? "not captured"}
                </p>
              ))}
            </>
          )}
          <p className="form-note">
            Adjustments accept a positive receipt or negative issue. Transfers
            accept positive quantities. Count quantities are absolute physical
            counts.
          </p>
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={closeForm}>
              Cancel
            </Button>
            <Button
              type="submit"
              busy={action.busy}
              disabled={
                !lines.length ||
                (form.type === "count" &&
                  (snapshotBusy ||
                    lines.some((l) => l.expected_version === undefined)))
              }
            >
              Post stock document
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={reconOpen}
        onClose={() => setReconOpen(false)}
        title="Inventory reconciliation"
        description="Authoritative stock ledger compared with cached balances and inventory control account."
      >
        {recon.error && <ErrorCard error={recon.error} />}{" "}
        {recon.data && (
          <>
            <div
              className={`reconciliation-status ${recon.data.matches ? "ok" : "bad"}`}
            >
              <CheckCheck size={30} />
              <h3>
                {recon.data.matches
                  ? "Everything balances."
                  : "Investigation required."}
              </h3>
              <p>
                {recon.data.movement_discrepancies.length} movement
                discrepancies
              </p>
            </div>
            <div className="detail-grid">
              <div>
                <span>Stock ledger value</span>
                <strong>
                  {currency(recon.data.stock_value, meta.company.currency)}
                </strong>
              </div>
              <div>
                <span>Inventory GL</span>
                <strong>
                  {currency(recon.data.inventory_gl, meta.company.currency)}
                </strong>
              </div>
              <div>
                <span>Difference</span>
                <strong>
                  {currency(recon.data.difference, meta.company.currency)}
                </strong>
              </div>
            </div>
            {recon.data.movement_discrepancies.length > 0 && (
              <pre>
                {JSON.stringify(recon.data.movement_discrepancies, null, 2)}
              </pre>
            )}
          </>
        )}
      </Dialog>
    </>
  );
}
