"use client";
import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Plus,
  ArrowUpRight,
  Printer,
  RotateCcw,
  ReceiptText,
  ArrowRight,
  Check,
  Clock3,
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
  FormField,
} from "../ui";
import { useList, useAction } from "./common";
export function SalesPage() {
  const { meta, actor } = useWorkspace(),
    params = useSearchParams();
  const [tab, setTab] = useState("invoices"),
    [selected, setSelected] = useState<any>(null),
    [invoice, setInvoice] = useState<any>(null),
    [returnOpen, setReturnOpen] = useState(false),
    [returnLines, setReturnLines] = useState<any[]>([]),
    [reason, setReason] = useState(""),
    [methodId, setMethodId] = useState(""),
    [reference, setReference] = useState(""),
    [shiftId, setShiftId] = useState(""),
    [accountCredit, setAccountCredit] = useState(false),
    [refundAmount, setRefundAmount] = useState("0"),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const list = useList(tab === "invoices" ? "/sales" : "/sales/returns/list", {
    from: from || undefined,
    to: to || undefined,
  });
  const action = useAction((r) => {
    setReturnOpen(false);
    list.refresh();
    if (invoice) load(invoice.id);
  });
  const shifts = useQuery<any>(returnOpen ? "/shifts?limit=50" : null);
  async function load(id: string) {
    setSelected({ id });
    setInvoice(null);
    action.setError(null);
    try {
      setInvoice(await api("/sales/" + id));
    } catch (e) {
      action.setError(e);
    }
  }
  useEffect(() => {
    if (params.get("open")) load(params.get("open")!);
  }, [params.get("open")]);
  function beginReturn() {
    action.setError(null);
    setReturnLines(
      invoice.lines.map((l: any) => ({
        sale_line_id: l.id,
        line: l,
        quantity: "0",
        restock: true,
      })),
    );
    setReason("");
    setMethodId(
      meta.payment_methods.find((m: any) => m.kind === "cash")?.id ?? "",
    );
    setReference("");
    setShiftId("");
    setRefundAmount("0");
    setAccountCredit(false);
    setReturnOpen(true);
  }
  function estimate(rows: any[]) {
    let total = D(0);
    for (const r of rows) {
      try {
        total = total.plus(
          D(r.line.total)
            .times(r.quantity || 0)
            .div(r.line.quantity)
            .toDecimalPlaces(2),
        );
      } catch {}
    }
    const due = D(invoice?.outstanding ?? 0);
    return { total, refund: total.minus(due).gt(0) ? total.minus(due) : D(0) };
  }
  const est = estimate(returnLines),
    method = meta.payment_methods.find((m: any) => m.id === methodId);
  function updateRows(rows: any[]) {
    setReturnLines(rows);
    setRefundAmount(money(estimate(rows).refund));
  }
  async function submitReturn(e: React.FormEvent) {
    e.preventDefault();
    const pending = method?.kind === "mpesa";
    await action.run(
      () =>
        api("/sales/returns", {
          method: "POST",
          body: {
            sale_id: invoice.id,
            reason,
            lines: returnLines
              .filter((r) => D(r.quantity || 0).gt(0))
              .map(({ sale_line_id, quantity, restock }) => ({
                sale_line_id,
                quantity,
                restock,
              })),
            credit_to_account: accountCredit,
            ...(shiftId ? { shift_id: shiftId } : {}),
            ...(pending && !accountCredit && D(refundAmount).gt(0)
              ? {
                  pending_refund: { method_id: methodId, amount: refundAmount },
                }
              : {}),
            payments:
              !pending && !accountCredit && D(refundAmount).gt(0)
                ? [
                    {
                      method_id: methodId,
                      amount: refundAmount,
                      ...(reference ? { reference } : {}),
                    },
                  ]
                : [],
          },
        }),
      "Credit note posted. The original sale is preserved.",
    );
  }
  return (
    <>
      <PageHeading
        eyebrow="SALES"
        title="Sales & invoices"
        description="Every sale, tender and return. Connected from checkout to the ledger."
      >
        {actor.permissions.includes("sales.create") && (
          <Link href="/pos" className="btn primary">
            <Plus size={17} /> New sale
          </Link>
        )}
      </PageHeading>
      <div className="page-tabs">
        <button
          className={tab === "invoices" ? "active" : ""}
          onClick={() => setTab("invoices")}
        >
          Invoices
        </button>
        <button
          className={tab === "returns" ? "active" : ""}
          onClick={() => setTab("returns")}
        >
          Returns & credit notes
        </button>
      </div>
      <section className="card">
        <div className="table-toolbar">
          <SearchBox
            value={list.search}
            onChange={list.setSearch}
            placeholder="Search invoice or customer…"
          />
          <div className="date-filter">
            <input
              type="date"
              aria-label="Sales from date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <span>to</span>
            <input
              type="date"
              aria-label="Sales to date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
        {list.error && <ErrorCard error={list.error} />}
        <DataTable
          items={list.data?.items}
          loading={list.loading}
          onRow={(r) => load(tab === "invoices" ? r.id : r.sale_id)}
          columns={
            tab === "invoices"
              ? [
                  {
                    key: "number",
                    title: "Invoice",
                    render: (r) => (
                      <span className="reference-link">{r.number}</span>
                    ),
                  },
                  {
                    key: "accounting_date",
                    title: "Date",
                    render: (r) => dateText(r.accounting_date),
                  },
                  {
                    key: "customer",
                    title: "Customer",
                    render: (r) => r.customer ?? "Walk-in customer",
                  },
                  { key: "cashier", title: "Created by" },
                  {
                    key: "total",
                    title: "Total",
                    align: "right",
                    render: (r) => (
                      <strong>
                        {currency(r.total, meta.company.currency)}
                      </strong>
                    ),
                  },
                  {
                    key: "outstanding",
                    title: "Outstanding",
                    align: "right",
                    render: (r) =>
                      currency(r.outstanding, meta.company.currency),
                  },
                  {
                    key: "status",
                    title: "Status",
                    render: (r) => (
                      <Badge
                        status={D(r.outstanding).gt(0) ? "partial" : "paid"}
                      >
                        {D(r.outstanding).gt(0) ? "Part paid" : "Paid"}
                      </Badge>
                    ),
                  },
                ]
              : [
                  { key: "number", title: "Credit note" },
                  { key: "sale_number", title: "Original sale" },
                  {
                    key: "accounting_date",
                    title: "Date",
                    render: (r) => dateText(r.accounting_date),
                  },
                  {
                    key: "total",
                    title: "Credit value",
                    align: "right",
                    render: (r) => currency(r.total, meta.company.currency),
                  },
                  {
                    key: "refund",
                    title: "Confirmed refund",
                    align: "right",
                    render: (r) => currency(r.refund, meta.company.currency),
                  },
                  {
                    key: "pending_refund",
                    title: "Pending refund",
                    align: "right",
                    render: (r) =>
                      currency(r.pending_refund, meta.company.currency),
                  },
                  { key: "reason", title: "Reason" },
                ]
          }
        />
        <Pagination
          page={list.page}
          total={list.data?.total ?? 0}
          onChange={list.setPage}
        />
      </section>
      <Dialog
        open={!!selected && !returnOpen}
        onClose={() => setSelected(null)}
        title={invoice?.number ?? "Loading invoice…"}
        description={
          invoice
            ? `${dateText(invoice.accounting_date)} · ${invoice.customer_id ? "Registered customer" : "Walk-in customer"} · Immutable posted sale`
            : ""
        }
        wide
      >
        {action.error && <ErrorCard error={action.error} />}{" "}
        {invoice && (
          <>
            <div className="detail-grid">
              <div>
                <span>Invoice total</span>
                <strong>
                  {currency(invoice.total, meta.company.currency)}
                </strong>
              </div>
              <div>
                <span>Paid at checkout</span>
                <strong>
                  {currency(invoice.paid_at_sale, meta.company.currency)}
                </strong>
              </div>
              <div>
                <span>Subsequent allocations</span>
                <strong>
                  {currency(invoice.allocated, meta.company.currency)}
                </strong>
              </div>
              <div>
                <span>Outstanding</span>
                <strong>
                  {currency(invoice.outstanding, meta.company.currency)}
                </strong>
              </div>
            </div>
            <DataTable
              items={invoice.lines}
              columns={[
                { key: "description", title: "Product / service" },
                {
                  key: "quantity",
                  title: "Quantity",
                  align: "right",
                  render: (r) => number(r.quantity) + " " + r.unit,
                },
                {
                  key: "unit_price",
                  title: "Unit price",
                  align: "right",
                  render: (r) => currency(r.unit_price, meta.company.currency),
                },
                {
                  key: "tax",
                  title: "Tax",
                  align: "right",
                  render: (r) => currency(r.tax, meta.company.currency),
                },
                {
                  key: "total",
                  title: "Total",
                  align: "right",
                  render: (r) => (
                    <strong>{currency(r.total, meta.company.currency)}</strong>
                  ),
                },
              ]}
            />
            <h3 className="subheading">Confirmed tenders</h3>
            <div className="tender-summary">
              {invoice.payments.map((p: any) => (
                <div key={p.id}>
                  <span>
                    {p.method}
                    <small>{p.reference ?? "Cash tender"}</small>
                  </span>
                  <strong>{currency(p.amount, meta.company.currency)}</strong>
                </div>
              ))}
            </div>
            <div className="warning-box">
              <ReceiptText size={18} />
              <p>
                {invoice.fiscal?.status === "successful"
                  ? `Fiscal identifier: ${invoice.fiscal.fiscal_id}`
                  : `This document is not a KRA fiscal invoice. Fiscal submission status: ${invoice.fiscal?.status ?? "disabled"}.`}
              </p>
            </div>
            <div className="form-actions">
              <a
                className="btn secondary"
                href={`/api/v1/sales/${invoice.id}/receipt`}
                target="_blank"
                rel="noreferrer"
              >
                <Printer size={16} /> A4 invoice
              </a>
              <a
                className="btn secondary"
                href={`/api/v1/sales/${invoice.id}/receipt?thermal=true`}
                target="_blank"
                rel="noreferrer"
              >
                <Printer size={16} /> Thermal receipt
              </a>
              {actor.permissions.includes("sales.return") && (
                <Button onClick={beginReturn}>
                  <RotateCcw size={16} /> Return / credit note
                </Button>
              )}
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={returnOpen}
        onClose={() => setReturnOpen(false)}
        title="Return goods & issue credit"
        description="Return quantities are capped by the original sale. Only physically accepted restock items increase inventory."
        wide
      >
        <form onSubmit={submitReturn}>
          {action.error && <ErrorCard error={action.error} />}
          <div className="return-lines">
            {returnLines.map((r, i) => (
              <div key={r.sale_line_id}>
                <div>
                  <strong>{r.line.description}</strong>
                  <small>
                    Originally {r.line.quantity} {r.line.unit} ·{" "}
                    {currency(r.line.total, meta.company.currency)}
                  </small>
                </div>
                <FormField label="Return quantity">
                  <input
                    type="number"
                    min="0"
                    max={r.line.quantity}
                    step="0.000001"
                    value={r.quantity}
                    onChange={(e) =>
                      updateRows(
                        returnLines.map((x, j) =>
                          j === i ? { ...x, quantity: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </FormField>
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={r.restock}
                    onChange={(e) =>
                      updateRows(
                        returnLines.map((x, j) =>
                          j === i ? { ...x, restock: e.target.checked } : x,
                        ),
                      )
                    }
                  />{" "}
                  Restock usable goods
                </label>
              </div>
            ))}
          </div>
          <FormField label="Reason for return" required>
            <textarea
              rows={3}
              minLength={5}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </FormField>
          <div className="payment-balance">
            <span>Estimated credit value</span>
            <strong>{currency(est.total, meta.company.currency)}</strong>
          </div>
          <p className="form-note">
            Any outstanding invoice balance is credited first. Estimated paid
            portion to settle: {currency(est.refund, meta.company.currency)}.
            Server calculations and prior returns are authoritative.
          </p>
          {invoice?.customer_id && (
            <label className="inline-check">
              <input
                type="checkbox"
                checked={accountCredit}
                onChange={(e) => setAccountCredit(e.target.checked)}
              />{" "}
              Keep the paid portion as customer account credit
            </label>
          )}
          {!accountCredit && (
            <div className="form-grid">
              <FormField label="Refund method">
                <select
                  value={methodId}
                  onChange={(e) => setMethodId(e.target.value)}
                >
                  {meta.payment_methods
                    .filter((m: any) => m.active)
                    .map((m: any) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </FormField>
              <FormField label="Refund / pending refund amount">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                />
              </FormField>
              {method?.kind === "cash" && (
                <FormField label="Open cash shift">
                  <select
                    value={shiftId}
                    onChange={(e) => setShiftId(e.target.value)}
                  >
                    <option value="">Choose shift for cash refund</option>
                    {shifts.data?.items
                      ?.filter(
                        (s: any) =>
                          s.branch_id === invoice.branch_id &&
                          ["open", "rejected"].includes(s.status),
                      )
                      .map((s: any) => (
                        <option key={s.id} value={s.id}>
                          {s.register} · {s.cashier}
                        </option>
                      ))}
                  </select>
                </FormField>
              )}
              {method?.requires_reference && method.kind !== "mpesa" && (
                <FormField label="Confirmed refund reference">
                  <input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                  />
                </FormField>
              )}
            </div>
          )}
          {method?.kind === "mpesa" && !accountCredit && (
            <div className="warning-box">
              <Clock3 size={18} />
              <p>
                External M-Pesa refunds are recorded as pending requests and a
                refund liability. They are not treated as settled until
                independently reconciled in Integrations.
              </p>
            </div>
          )}
          <div className="form-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setReturnOpen(false)}
            >
              Cancel
            </Button>
            <Button busy={action.busy} type="submit">
              Post credit note <Check size={16} />
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
