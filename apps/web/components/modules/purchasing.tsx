"use client";
import { SupplierCreditPanel } from "./supplier-credits";
import React, { useState } from "react";
import {
  Plus,
  Truck,
  Check,
  ArrowRight,
  Printer,
  PackageCheck,
  ReceiptText,
  RotateCcw,
} from "lucide-react";
import {
  api,
  useWorkspace,
  currency,
  number,
  dateText,
  D,
  money,
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
  SearchSelect,
  LineEditor,
} from "../ui";
import { useList, useAction, clean } from "./common";
export function PurchasingPage() {
  const { meta, actor, branch } = useWorkspace();
  const [tab, setTab] = useState("orders"),
    [open, setOpen] = useState(false),
    [form, setForm] = useState<any>({}),
    [supplier, setSupplier] = useState<any>(null),
    [lines, setLines] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [mode, setMode] = useState(""),
    [detail, setDetail] = useState<any>(null),
    [reason, setReason] = useState(""),
    [transition, setTransition] = useState(""),
    [receiveLines, setReceiveLines] = useState<any[]>([]),
    [invoiceLines, setInvoiceLines] = useState<any[]>([]),
    [invoiceForm, setInvoiceForm] = useState<any>({}),
    [returnLines, setReturnLines] = useState<any[]>([]);
  const list = useList("/purchases/" + tab);
  const action = useAction(() => {
    setOpen(false);
    list.refresh();
  });
  const workflow = useAction(async () => {
    setMode("");
    list.refresh();
    if (selected) load(selected.id, selected?.kind);
  });
  function create() {
    action.setError(null);
    setForm({
      warehouse_id:
        meta.warehouses.find((w: any) => !branch || w.branch_id === branch)
          ?.id ?? "",
      expected_date: "",
      notes: "",
    });
    setLines([]);
    setSupplier(null);
    setOpen(true);
  }
  async function load(id: string, kind = tab) {
    setSelected({ id, kind });
    setDetail(null);
    workflow.setError(null);
    try {
      setDetail(await api("/purchases/" + kind + "/" + id));
    } catch (e) {
      workflow.setError(e);
    }
  }
  function receive() {
    workflow.setError(null);
    setMode("receive");
    setReason("");
    setReceiveLines(
      detail.lines.map((l: any) => ({
        order_line_id: l.id,
        line: l,
        quantity: D(l.quantity).minus(l.received).gt(0)
          ? D(l.quantity).minus(l.received).toString()
          : "0",
        rejected_quantity: "0",
        batch_number: "",
        expiry_date: "",
        serials: "",
      })),
    );
  }
  function invoice() {
    workflow.setError(null);
    setMode("invoice");
    setInvoiceForm({
      supplier_reference: "",
      due_date: new Date(Date.now() + 30 * 86400000).toLocaleDateString(
        "en-CA",
      ),
    });
    setInvoiceLines(
      detail.lines.map((l: any) => ({
        receipt_line_id: l.id,
        line: l,
        net: money(l.value),
        tax_rule_id: l.tax_rule_id,
      })),
    );
  }
  function beginTransition(status: string) {
    workflow.setError(null);
    setTransition(status);
    setReason("");
    setMode("transition");
  }
  async function postWorkflow(e: React.FormEvent) {
    e.preventDefault();
    await workflow.run(
      () =>
        mode === "transition"
          ? api("/purchases/orders/" + detail.id + "/transition", {
              method: "POST",
              body: { status: transition, reason },
            })
          : mode === "receive"
            ? api("/purchases/receipts", {
                method: "POST",
                body: {
                  order_id: detail.id,
                  ...(reason ? { reason } : {}),
                  lines: receiveLines
                    .filter((l) => D(l.quantity || 0).gt(0))
                    .map((l) =>
                      clean({
                        order_line_id: l.order_line_id,
                        quantity: l.quantity,
                        rejected_quantity: l.rejected_quantity || "0",
                        batch_number: l.batch_number,
                        expiry_date: l.expiry_date,
                        serials: l.serials
                          .split("\n")
                          .map((s: string) => s.trim())
                          .filter(Boolean),
                      }),
                    ),
                },
              })
            : mode === "invoice"
              ? api("/purchases/invoices", {
                  method: "POST",
                  body: {
                    receipt_id: detail.id,
                    ...invoiceForm,
                    lines: invoiceLines.map(
                      ({ receipt_line_id, net, tax_rule_id }) => ({
                        receipt_line_id,
                        net,
                        tax_rule_id,
                      }),
                    ),
                  },
                })
              : api("/purchases/returns", {
                  method: "POST",
                  body: {
                    invoice_id: detail.id,
                    reason,
                    lines: returnLines
                      .filter((l) => D(l.quantity || 0).gt(0))
                      .map((l) => ({
                        receipt_line_id: l.receipt_line_id,
                        quantity: l.quantity,
                        serials: (l.serials ?? "").split("\n").filter(Boolean),
                      })),
                  },
                }),
      mode === "transition"
        ? "Purchase order state updated."
        : mode === "receive"
          ? "Goods accepted. Stock and GRNI are posted; supplier invoice is still separate."
          : mode === "invoice"
            ? "Matched supplier liability and input tax posted."
            : "Supplier return and credit posted.",
    );
  }
  return (
    <>
      <PageHeading
        eyebrow="PROCUREMENT"
        title="Purchasing"
        description="From request to receipt to payment. Every step stays traceable."
      >
        {actor.permissions.includes("purchases.create") && (
          <Button onClick={create}>
            <Plus size={17} /> Purchase order
          </Button>
        )}
      </PageHeading>
      <div className="workflow-strip">
        <span>Purchase order</span>
        <ArrowRight size={14} />
        <span>Approval</span>
        <ArrowRight size={14} />
        <span>Goods received</span>
        <ArrowRight size={14} />
        <span>Supplier invoice</span>
        <ArrowRight size={14} />
        <span>Payment</span>
      </div>
      <div className="page-tabs">
        {[
          ["orders", "Purchase orders"],
          ["receipts", "Goods receipts"],
          ["invoices", "Supplier invoices"],
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
            placeholder="Search reference or supplier…"
          />
          <span className="muted">{list.data?.total ?? 0} documents</span>
        </div>
        {list.error && <ErrorCard error={list.error} />}
        <DataTable
          loading={list.loading}
          items={list.data?.items}
          onRow={(r) => load(r.id)}
          columns={[
            {
              key: "number",
              title: "Reference",
              render: (r) => <span className="reference-link">{r.number}</span>,
            },
            { key: "supplier", title: "Supplier" },
            {
              key: "created_at",
              title: "Created",
              render: (r) => dateText(r.created_at),
            },
            ...(tab === "invoices"
              ? [{ key: "supplier_reference", title: "Supplier invoice" }]
              : []),
            {
              key: "total",
              title: tab === "receipts" ? "Receipt value" : "Value",
              align: "right",
              render: (r) => (
                <strong>
                  {currency(r.total ?? r.value, meta.company.currency)}
                </strong>
              ),
            },
            ...(tab === "invoices"
              ? [
                  {
                    key: "outstanding",
                    title: "Outstanding",
                    align: "right" as const,
                    render: (r: any) =>
                      currency(r.outstanding, meta.company.currency),
                  },
                ]
              : []),
            {
              key: "status",
              title: "Status",
              render: (r) => (
                <Badge status={r.status ?? "posted"}>
                  {r.status ?? "posted"}
                </Badge>
              ),
            },
            { key: "view", title: "", render: () => <ArrowRight size={16} /> },
          ]}
        />
        <Pagination
          page={list.page}
          total={list.data?.total ?? 0}
          onChange={list.setPage}
        />
      </section>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Create purchase order"
        description="Quantities and costs are in base units. Submitted orders require approval before receiving."
        wide
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.run(
              () =>
                api("/purchases/orders", {
                  method: "POST",
                  body: clean({
                    ...form,
                    supplier_id: supplier?.id,
                    lines: lines.map((l) => ({
                      product_id: l.product_id,
                      quantity: l.quantity,
                      unit_cost: l.unit_cost,
                    })),
                  }),
                }),
              "Purchase order created as a draft.",
            );
          }}
        >
          {action.error && <ErrorCard error={action.error} />}
          <SearchSelect
            endpoint="/suppliers"
            label="Supplier"
            value={supplier}
            onChange={setSupplier}
          />
          <Fields
            fields={[
              {
                key: "warehouse_id",
                label: "Receiving warehouse",
                type: "select",
                options: meta.warehouses,
                required: true,
              },
              {
                key: "expected_date",
                label: "Expected delivery",
                type: "date",
              },
              { key: "notes", label: "Notes", type: "textarea", full: true },
            ]}
            value={form}
            onChange={setForm}
          />
          <LineEditor lines={lines} onChange={setLines} costMode />
          <div className="form-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              busy={action.busy}
              type="submit"
              disabled={!supplier || !lines.length}
            >
              Create draft PO
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!selected && !mode}
        onClose={() => {
          setSelected(null);
          setDetail(null);
        }}
        title={detail?.number ?? "Loading…"}
        description={
          detail
            ? `${detail.supplier} · ${selected?.kind === "orders" ? "Purchase order" : selected?.kind === "receipts" ? "Physical goods receipt" : "Recognized supplier invoice"}`
            : ""
        }
        wide
      >
        {workflow.error && <ErrorCard error={workflow.error} />}{" "}
        {detail && selected && (
          <>
            <div className="detail-grid">
              <div>
                <span>Status</span>
                <Badge status={detail.status ?? "posted"}>
                  {detail.status ?? "posted"}
                </Badge>
              </div>
              <div>
                <span>Value</span>
                <strong>
                  {currency(
                    detail.total ?? detail.value,
                    meta.company.currency,
                  )}
                </strong>
              </div>
              {detail.supplier_reference && (
                <div>
                  <span>Supplier reference</span>
                  <strong>{detail.supplier_reference}</strong>
                </div>
              )}
              {detail.order_number && (
                <div>
                  <span>Original PO</span>
                  <strong>{detail.order_number}</strong>
                </div>
              )}
            </div>
            <DataTable
              items={detail.lines}
              columns={[
                { key: "name", title: "Product" },
                {
                  key: "quantity",
                  title: "Quantity",
                  align: "right",
                  render: (r) => number(r.quantity),
                },
                {
                  key: "received",
                  title: selected?.kind === "orders" ? "Received" : "Unit cost",
                  align: "right",
                  render: (r) =>
                    selected?.kind === "orders"
                      ? number(r.received)
                      : currency(
                          r.unit_cost ?? D(r.net).div(r.quantity),
                          meta.company.currency,
                        ),
                },
                {
                  key: "unit_cost",
                  title:
                    selected?.kind === "invoices"
                      ? "Net invoiced"
                      : "Unit cost",
                  align: "right",
                  render: (r) =>
                    currency(r.unit_cost ?? r.net, meta.company.currency),
                },
              ]}
            />
            {selected?.kind === "invoices" && (
              <SupplierCreditPanel
                invoice={detail}
                onChanged={async () => {
                  list.refresh();
                  await load(detail.id, "invoices");
                }}
              />
            )}
            <div className="form-actions">
              {selected?.kind !== "invoices" && (
                <a
                  className="btn secondary"
                  href={`/api/v1/print/${selected?.kind === "orders" ? "purchase-order" : "goods-receipt"}/${detail.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Printer size={16} /> Print
                </a>
              )}
              {selected?.kind === "orders" && (
                <>
                  {["draft", "rejected"].includes(detail.status) && (
                    <Button
                      variant="secondary"
                      onClick={() => beginTransition("submitted")}
                    >
                      Submit for approval
                    </Button>
                  )}
                  {detail.status === "submitted" &&
                    actor.permissions.includes("purchases.approve") && (
                      <>
                        <Button
                          variant="secondary"
                          onClick={() => beginTransition("rejected")}
                        >
                          Reject
                        </Button>
                        <Button onClick={() => beginTransition("approved")}>
                          <Check size={16} /> Approve order
                        </Button>
                      </>
                    )}
                  {detail.status === "approved" &&
                    actor.permissions.includes("purchases.receive") && (
                      <Button onClick={receive}>
                        <PackageCheck size={16} /> Receive goods
                      </Button>
                    )}
                  {detail.status === "approved" && (
                    <Button
                      variant="secondary"
                      onClick={() => beginTransition("closed")}
                    >
                      Close remaining
                    </Button>
                  )}
                </>
              )}
              {selected?.kind === "receipts" &&
                actor.permissions.includes("purchases.create") && (
                  <Button onClick={invoice}>
                    <ReceiptText size={16} /> Match supplier invoice
                  </Button>
                )}
              {selected?.kind === "invoices" &&
                actor.permissions.includes("inventory.write") && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setMode("return");
                      setReason("");
                      setReturnLines(
                        detail.lines.map((l: any) => ({
                          receipt_line_id: l.receipt_line_id,
                          line: l,
                          quantity: "0",
                          serials: "",
                        })),
                      );
                    }}
                  >
                    <RotateCcw size={16} /> Supplier return
                  </Button>
                )}
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={!!mode}
        onClose={() => setMode("")}
        title={
          mode === "transition"
            ? `${transition[0]?.toUpperCase() + transition.slice(1)} purchase order`
            : mode === "receive"
              ? "Receive accepted goods"
              : mode === "invoice"
                ? "Match supplier invoice"
                : "Return goods to supplier"
        }
        description={
          mode === "invoice"
            ? "Recognizes the supplier liability and recoverable tax. This does not receive stock a second time."
            : mode === "receive"
              ? "Record accepted base quantities; rejected quantities are noted but never put into usable stock."
              : "An explicit reason and authority check protect the audit trail."
        }
        wide
      >
        <form onSubmit={postWorkflow}>
          {workflow.error && <ErrorCard error={workflow.error} />}{" "}
          {mode === "receive" && (
            <div className="receive-lines">
              {receiveLines.map((l, i) => (
                <div className="receive-line" key={i}>
                  <h3>
                    {l.line.name}
                    <small>
                      Ordered {l.line.quantity} · already received{" "}
                      {l.line.received}
                    </small>
                  </h3>
                  <div className="form-grid">
                    <FormField label="Accepted quantity">
                      <input
                        type="number"
                        min="0"
                        step="0.000001"
                        value={l.quantity}
                        onChange={(e) =>
                          setReceiveLines((rows) =>
                            rows.map((x, j) =>
                              j === i ? { ...x, quantity: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </FormField>
                    <FormField label="Rejected quantity">
                      <input
                        type="number"
                        min="0"
                        step="0.000001"
                        value={l.rejected_quantity}
                        onChange={(e) =>
                          setReceiveLines((rows) =>
                            rows.map((x, j) =>
                              j === i
                                ? { ...x, rejected_quantity: e.target.value }
                                : x,
                            ),
                          )
                        }
                      />
                    </FormField>
                    {l.line.batch_tracked && (
                      <FormField label="Batch number">
                        <input
                          value={l.batch_number}
                          onChange={(e) =>
                            setReceiveLines((rows) =>
                              rows.map((x, j) =>
                                j === i
                                  ? { ...x, batch_number: e.target.value }
                                  : x,
                              ),
                            )
                          }
                        />
                      </FormField>
                    )}
                    {l.line.expiry_tracked && (
                      <FormField label="Expiry">
                        <input
                          type="date"
                          value={l.expiry_date}
                          onChange={(e) =>
                            setReceiveLines((rows) =>
                              rows.map((x, j) =>
                                j === i
                                  ? { ...x, expiry_date: e.target.value }
                                  : x,
                              ),
                            )
                          }
                        />
                      </FormField>
                    )}
                    {l.line.serial_tracked && (
                      <FormField label="Accepted serial numbers, one per line">
                        <textarea
                          value={l.serials}
                          onChange={(e) =>
                            setReceiveLines((rows) =>
                              rows.map((x, j) =>
                                j === i ? { ...x, serials: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </FormField>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {mode === "invoice" && (
            <>
              <Fields
                fields={[
                  {
                    key: "supplier_reference",
                    label: "Supplier invoice number",
                    required: true,
                  },
                  {
                    key: "due_date",
                    label: "Due date",
                    type: "date",
                    required: true,
                  },
                ]}
                value={invoiceForm}
                onChange={setInvoiceForm}
              />
              {invoiceLines.map((l, i) => (
                <div className="invoice-match-line" key={i}>
                  <strong>
                    {l.line.name}
                    <small>
                      Received {l.line.quantity} · accrued{" "}
                      {currency(l.line.value, meta.company.currency)}
                    </small>
                  </strong>
                  <FormField label="Net amount excluding tax">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.net}
                      onChange={(e) =>
                        setInvoiceLines((rows) =>
                          rows.map((x, j) =>
                            j === i ? { ...x, net: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </FormField>
                  <FormField label="Tax rule">
                    <select
                      value={l.tax_rule_id}
                      onChange={(e) =>
                        setInvoiceLines((rows) =>
                          rows.map((x, j) =>
                            j === i ? { ...x, tax_rule_id: e.target.value } : x,
                          ),
                        )
                      }
                    >
                      {meta.tax_rules
                        .filter((t: any) => t.active)
                        .map((t: any) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                    </select>
                  </FormField>
                </div>
              ))}
            </>
          )}
          {mode === "return" &&
            returnLines.map((l, i) => (
              <div className="receive-line" key={i}>
                <h3>
                  {l.line.name}
                  <small>
                    Received {l.line.quantity} · previously returned{" "}
                    {l.line.returned}
                  </small>
                </h3>
                <FormField label="Return quantity">
                  <input
                    type="number"
                    step="0.000001"
                    min="0"
                    value={l.quantity}
                    onChange={(e) =>
                      setReturnLines((rows) =>
                        rows.map((x, j) =>
                          j === i ? { ...x, quantity: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </FormField>
                {l.line.serial_tracked && (
                  <FormField label="Returned serial numbers, one per line">
                    <textarea
                      value={l.serials}
                      onChange={(e) =>
                        setReturnLines((rows) =>
                          rows.map((x, j) =>
                            j === i ? { ...x, serials: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </FormField>
                )}
              </div>
            ))}
          {mode !== "invoice" && (
            <FormField
              label={
                mode === "receive"
                  ? "Delivery note / reason (required for over-delivery)"
                  : "Reason"
              }
              required={mode !== "receive"}
            >
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                minLength={mode === "receive" ? undefined : 5}
                required={mode !== "receive"}
              />
            </FormField>
          )}
          <div className="form-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setMode("")}
            >
              Cancel
            </Button>
            <Button busy={workflow.busy} type="submit">
              {mode === "transition"
                ? "Confirm transition"
                : mode === "receive"
                  ? "Post goods receipt"
                  : mode === "invoice"
                    ? "Post supplier invoice"
                    : "Post supplier return"}{" "}
              <Check size={16} />
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
