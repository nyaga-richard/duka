"use client";
import React, { useState } from "react";
import { api, useQuery, useWorkspace, currency, dateText, D } from "../lib";
import { Button, Dialog, FormField, ErrorCard, DataTable, Badge } from "../ui";
import { useAction } from "./common";
export function ExpenseRefundPanel({
  expenseId,
  onChanged,
}: {
  expenseId: string;
  onChanged: () => void;
}) {
  const { meta, actor } = useWorkspace(),
    expense = useQuery<any>("/expenses/" + expenseId);
  const [open, setOpen] = useState(false),
    [original, setOriginal] = useState<any>(null),
    [amount, setAmount] = useState("0"),
    [method, setMethod] = useState(""),
    [reference, setReference] = useState(""),
    [shift, setShift] = useState(""),
    [reason, setReason] = useState("");
  const action = useAction(() => {
    setOpen(false);
    setOriginal(null);
    expense.refresh();
    onChanged();
  });
  const selectedMethod = meta.payment_methods.find((m: any) => m.id === method),
    shifts = useQuery<any>(
      open && selectedMethod?.kind === "cash"
        ? `/shifts?branch_id=${expense.data?.branch_id}&limit=100`
        : null,
    );
  const allowed =
    actor.permissions.includes("expenses.pay") &&
    actor.permissions.includes("expenses.approve");
  function begin(row?: any) {
    action.setError(null);
    setOriginal(row ?? null);
    setAmount(row?.amount ?? expense.data?.remaining ?? "0");
    setMethod(
      meta.payment_methods.find((m: any) => m.kind === "bank" && m.active)
        ?.id ?? "",
    );
    setReference("");
    setShift("");
    setReason("");
    setOpen(true);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await action.run(
      () =>
        api(
          original
            ? `/expenses/refunds/${original.id}/reverse`
            : `/expenses/${expenseId}/refunds`,
          {
            method: "POST",
            body: {
              ...(!original ? { amount } : {}),
              payment: {
                method_id: method,
                ...(reference ? { reference } : {}),
              },
              ...(selectedMethod?.kind === "cash" ? { shift_id: shift } : {}),
              reason,
            },
          },
        ),
      original
        ? "Actual refund repayment posted; original records remain immutable."
        : "Actual expense refund received and posted.",
    );
  }
  if (expense.error)
    return <ErrorCard error={expense.error} retry={expense.refresh} />;
  if (!expense.data)
    return <p className="form-note">Loading expense refund history…</p>;
  const e = expense.data;
  return (
    <>
      <div className="detail-grid" style={{ marginTop: 16 }}>
        <div>
          <span>Actually posted</span>
          <strong>{dateText(e.posting_date)}</strong>
        </div>
        <div>
          <span>Refunded to date</span>
          <strong>{currency(e.refunded, meta.company.currency)}</strong>
        </div>
        <div>
          <span>Unrefunded paid amount</span>
          <strong>{currency(e.remaining, meta.company.currency)}</strong>
        </div>
      </div>
      {allowed && D(e.remaining).gt(0) && (
        <div className="form-actions">
          <Button variant="secondary" onClick={() => begin()}>
            Record expense refund
          </Button>
        </div>
      )}
      {!!e.refunds?.length && (
        <>
          <h3 className="subheading">Expense refund and repayment history</h3>
          <DataTable
            items={e.refunds}
            columns={[
              { key: "number", title: "Reference" },
              {
                key: "kind",
                title: "Action",
                render: (r) => (
                  <Badge>
                    {r.kind === "refund" ? "Refund received" : "Refund repaid"}
                    {r.reversed_by ? " · repaid" : ""}
                  </Badge>
                ),
              },
              {
                key: "accounting_date",
                title: "Date",
                render: (r) => dateText(r.accounting_date),
              },
              { key: "method", title: "Tender" },
              {
                key: "amount",
                title: "Gross",
                align: "right",
                render: (r) => currency(r.amount, meta.company.currency),
              },
              {
                key: "net",
                title: "Expense net",
                align: "right",
                render: (r) => currency(r.net, meta.company.currency),
              },
              {
                key: "tax",
                title: "VAT",
                align: "right",
                render: (r) => currency(r.tax, meta.company.currency),
              },
              {
                key: "print",
                title: "",
                render: (r) => (
                  <a
                    className="btn secondary"
                    href={`/api/v1/print/expense-refund/${r.id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Print {r.number}
                  </a>
                ),
              },
              {
                key: "correct",
                title: "",
                render: (r) =>
                  r.kind === "refund" &&
                  !r.reversed_by &&
                  allowed &&
                  actor.permissions.includes("accounting.reverse") ? (
                    <Button variant="ghost" onClick={() => begin(r)}>
                      Repay {r.number}
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
          original ? "Repay an expense refund" : "Record actual expense refund"
        }
        description={
          original
            ? "Record only an outgoing repayment that really occurred. This reverses the refund’s original net/VAT snapshots."
            : "Record money actually returned for this paid voucher. The original expense/payment is not deleted, and no transfer is initiated here."
        }
        wide
      >
        <form onSubmit={submit}>
          {action.error && <ErrorCard error={action.error} />}
          <div className="form-grid">
            <FormField
              label={
                original ? "Actual repayment amount" : "Actual refund amount"
              }
            >
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                readOnly={!!original}
                required
                onChange={(e) => setAmount(e.target.value)}
              />
            </FormField>
            <FormField
              label={original ? "Repayment tender" : "Refund received by"}
            >
              <select
                required
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              >
                <option value="">Choose actual confirmed tender</option>
                {meta.payment_methods
                  .filter(
                    (m: any) => m.active && (!original || m.kind !== "mpesa"),
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
              <FormField label="Confirmed expense transfer reference">
                <input
                  required
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </FormField>
            )}
            {selectedMethod?.kind === "cash" && (
              <FormField label="Refund cash shift">
                <select
                  required
                  value={shift}
                  onChange={(e) => setShift(e.target.value)}
                >
                  <option value="">Choose open cash drawer</option>
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
          </div>
          {shifts.error && <ErrorCard error={shifts.error} />}
          <p className="warning-box">
            No bank/M-Pesa transfer is sent or cancelled by this action. Use
            only independently confirmed money movements. Original net/tax
            limits, approval policy and cash availability are revalidated by the
            server. Use accountant-led correction for a payment that never
            happened, not a fictitious refund.
          </p>
          <FormField label="Expense refund or repayment reason">
            <textarea
              required
              minLength={5}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </FormField>
          <div className="form-actions">
            <Button type="submit" busy={action.busy}>
              {original
                ? "Post actual refund repayment"
                : "Post expense refund received"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
