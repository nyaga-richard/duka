"use client";
import React, { useState } from "react";
import {
  api,
  useWorkspace,
  useQuery,
  D,
  money,
  currency,
  dateText,
} from "../lib";
import {
  Button,
  Dialog,
  FormField,
  ErrorCard,
  DataTable,
  Badge,
  Pagination,
} from "../ui";
import { useAction } from "./common";
export function SupplierCreditPanel({
  invoice,
  onChanged,
}: {
  invoice: any;
  onChanged: () => Promise<void> | void;
}) {
  const { actor, meta } = useWorkspace();
  const [open, setOpen] = useState(false),
    [reversal, setReversal] = useState<any>(null),
    [kind, setKind] = useState("offset"),
    [amount, setAmount] = useState("0"),
    [target, setTarget] = useState(""),
    [targetPage, setTargetPage] = useState(1),
    [method, setMethod] = useState(""),
    [reference, setReference] = useState(""),
    [shift, setShift] = useState(""),
    [reason, setReason] = useState("");
  const action = useAction(async () => {
    setOpen(false);
    setReversal(null);
    await onChanged();
  });
  const refund = reversal ? reversal.kind === "refund" : kind === "refund";
  const selectedMethod = meta.payment_methods.find((m: any) => m.id === method);
  const targets = useQuery<any>(
    open && !reversal && !refund
      ? `/suppliers/${invoice.supplier_id}/open-items?branch_id=${invoice.branch_id}&limit=25&page=${targetPage}&document_type=invoice`
      : null,
  );
  const shifts = useQuery<any>(
    open && refund && selectedMethod?.kind === "cash"
      ? `/shifts?branch_id=${invoice.branch_id}&limit=100`
      : null,
  );
  const available = D(invoice.outstanding ?? 0)
    .neg()
    .gt(0)
    ? money(D(invoice.outstanding).neg())
    : "0.00";
  function begin(row?: any) {
    setReversal(row ?? null);
    setKind("offset");
    setAmount(row?.amount ?? available);
    setTarget("");
    setTargetPage(1);
    setMethod(
      row?.method_id ??
        meta.payment_methods.find((m: any) => m.kind === "bank" && m.active)
          ?.id ??
        "",
    );
    setReference("");
    setShift("");
    setReason("");
    action.setError(null);
    setOpen(true);
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const payment = refund
      ? { method_id: method, ...(reference ? { reference } : {}) }
      : undefined;
    const common = {
      reason,
      ...(payment ? { payment } : {}),
      ...(refund && selectedMethod?.kind === "cash" ? { shift_id: shift } : {}),
    };
    await action.run(
      () =>
        api(
          reversal
            ? `/purchases/credits/${reversal.id}/reverse`
            : "/purchases/credits/settle",
          {
            method: "POST",
            body: reversal
              ? common
              : {
                  ...common,
                  kind,
                  invoice_id: invoice.id,
                  amount,
                  ...(!refund ? { target_invoice_id: target } : {}),
                },
          },
        ),
      reversal
        ? "An append-only supplier credit correction was posted."
        : refund
          ? "Actual supplier refund received and posted."
          : "Supplier credit applied to the selected invoice.",
    );
  }
  return (
    <>
      <div className="detail-grid" style={{ marginTop: 18 }}>
        <div>
          <span>Invoice balance / credit</span>
          <strong>
            {currency(invoice.outstanding, meta.company.currency)}
          </strong>
        </div>
        <div>
          <span>Available supplier credit</span>
          <strong>{currency(available, meta.company.currency)}</strong>
        </div>
      </div>
      {D(available).gt(0) && actor.permissions.includes("payments.pay") && (
        <div className="form-actions">
          <Button variant="secondary" onClick={() => begin()}>
            Settle supplier credit
          </Button>
        </div>
      )}
      {!!invoice.credit_settlements?.length && (
        <>
          <h3 className="subheading">Supplier credit history</h3>
          <DataTable
            items={invoice.credit_settlements}
            columns={[
              { key: "number", title: "Reference" },
              {
                key: "kind",
                title: "Action",
                render: (r) => (
                  <Badge>
                    {r.kind}
                    {r.reversed_by ? " · reversed" : ""}
                  </Badge>
                ),
              },
              {
                key: "to_invoice",
                title: "Invoice / payment",
                render: (r) => r.to_invoice ?? r.method ?? "Correction",
              },
              {
                key: "accounting_date",
                title: "Date",
                render: (r) => dateText(r.accounting_date),
              },
              {
                key: "amount",
                title: "Amount",
                align: "right",
                render: (r) => currency(r.amount, meta.company.currency),
              },
              {
                key: "correction",
                title: "",
                render: (r) =>
                  r.kind !== "reversal" &&
                  !r.reversed_by &&
                  actor.permissions.includes("payments.pay") &&
                  actor.permissions.includes("accounting.reverse") ? (
                    <Button variant="ghost" onClick={() => begin(r)}>
                      Reverse {r.number}
                    </Button>
                  ) : null,
              },
            ]}
          />
        </>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={
          reversal
            ? "Reverse supplier credit settlement"
            : "Settle supplier credit"
        }
        description={
          reversal
            ? "The original record remains immutable. Refund reversal requires an actual outgoing repayment."
            : "Allocate an AP credit within the same supplier/branch, or record money actually refunded. No payment is initiated here."
        }
        wide
      >
        <form onSubmit={submit}>
          {action.error && <ErrorCard error={action.error} />}
          {!reversal && (
            <FormField label="Credit settlement type">
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="offset">
                  Apply to another supplier invoice
                </option>
                <option value="refund">Actual refund received</option>
              </select>
            </FormField>
          )}
          <div className="form-grid">
            <FormField label="Credit amount">
              <input
                type="number"
                min="0.01"
                step="0.01"
                required
                readOnly={!!reversal}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </FormField>
            {!reversal && !refund && (
              <FormField label="Target supplier invoice">
                <select
                  required
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">Choose an outstanding invoice</option>
                  {targets.data?.items
                    ?.filter(
                      (i: any) => i.id !== invoice.id && D(i.outstanding).gt(0),
                    )
                    .map((i: any) => (
                      <option key={i.id} value={i.id}>
                        {i.number} ·{" "}
                        {currency(i.outstanding, meta.company.currency)}
                      </option>
                    ))}
                </select>
              </FormField>
            )}
            {refund && (
              <>
                <FormField
                  label={
                    reversal
                      ? "Actual repayment method"
                      : "Actual refund method"
                  }
                >
                  <select
                    required
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                  >
                    <option value="">Choose confirmed payment method</option>
                    {meta.payment_methods
                      .filter(
                        (m: any) =>
                          m.active && (!reversal || m.kind !== "mpesa"),
                      )
                      .map((m: any) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </FormField>
                {(selectedMethod?.requires_reference ||
                  selectedMethod?.kind === "mpesa") && (
                  <FormField label="Confirmed transfer reference">
                    <input
                      required
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                    />
                  </FormField>
                )}
                {selectedMethod?.kind === "cash" && (
                  <FormField label="Open cash shift">
                    <select
                      required
                      value={shift}
                      onChange={(e) => setShift(e.target.value)}
                    >
                      <option value="">Choose open drawer</option>
                      {shifts.data?.items
                        ?.filter((s: any) =>
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
              </>
            )}
          </div>
          {!reversal && !refund && (
            <Pagination
              page={targetPage}
              total={targets.data?.total ?? 0}
              onChange={(p) => {
                setTarget("");
                setTargetPage(p);
              }}
            />
          )}
          {targets.error && <ErrorCard error={targets.error} />}{" "}
          {shifts.error && <ErrorCard error={shifts.error} />}
          {refund && (
            <p className="warning-box">
              Post only an actual confirmed transfer. A pending bank or M-Pesa
              promise is not a refund. Manual M-Pesa recording additionally
              requires integration-management authority and independent
              statement reconciliation.
            </p>
          )}
          <FormField label="Credit settlement reason">
            <textarea
              required
              minLength={5}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </FormField>
          <div className="form-actions">
            <Button
              type="submit"
              busy={action.busy}
              disabled={!refund && !reversal && targets.loading}
            >
              {reversal
                ? "Post credit settlement reversal"
                : "Post supplier credit settlement"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
