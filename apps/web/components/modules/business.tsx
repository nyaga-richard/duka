"use client";
import { ExpenseRefundPanel } from "./expense-refunds";
import React, { useState } from "react";
import Link from "next/link";
import {
  Plus,
  Check,
  Printer,
  ArrowRight,
  Clock3,
  Wallet,
  ReceiptText,
  ClipboardCheck,
  ArrowLeftRight,
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
  privateStore,
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
export function DocumentsPage() {
  const { meta, actor, branch } = useWorkspace(),
    list = useList("/documents");
  const [open, setOpen] = useState(false),
    [form, setForm] = useState<any>({}),
    [customer, setCustomer] = useState<any>(null),
    [supplier, setSupplier] = useState<any>(null),
    [lines, setLines] = useState<any[]>([]),
    [detail, setDetail] = useState<any>(null),
    [transition, setTransition] = useState(""),
    [reason, setReason] = useState(""),
    [convert, setConvert] = useState(false);
  const action = useAction(() => {
    setOpen(false);
    list.refresh();
  });
  const review = useAction(() => {
    setTransition("");
    setConvert(false);
    setDetail(null);
    list.refresh();
  });
  function create() {
    action.setError(null);
    setForm({
      kind: "quotation",
      branch_id: branch || meta.branches[0]?.id,
      warehouse_id: meta.warehouses[0]?.id,
      notes: "",
    });
    setLines([]);
    setCustomer(null);
    setSupplier(null);
    setOpen(true);
  }
  return (
    <>
      <PageHeading
        eyebrow="COMMERCIAL DOCUMENTS"
        title="Documents"
        description="Quotations, reserved sales orders, delivery notes and procurement requisitions."
      >
        <Button onClick={create}>
          <Plus size={17} /> Create document
        </Button>
      </PageHeading>
      <section className="card">
        <div className="table-toolbar">
          <SearchBox value={list.search} onChange={list.setSearch} />
          <span className="muted">
            No stock or revenue is posted by a quotation.
          </span>
        </div>
        {list.error && <ErrorCard error={list.error} />}
        <DataTable
          items={list.data?.items}
          loading={list.loading}
          onRow={setDetail}
          columns={[
            {
              key: "number",
              title: "Reference",
              render: (r) => <span className="reference-link">{r.number}</span>,
            },
            {
              key: "kind",
              title: "Type",
              render: (r) => r.kind.replaceAll("_", " "),
            },
            { key: "customer", title: "Customer" },
            {
              key: "created_at",
              title: "Created",
              render: (r) => dateText(r.created_at),
            },
            {
              key: "total",
              title: "Total",
              align: "right",
              render: (r) => currency(r.total, meta.company.currency),
            },
            {
              key: "status",
              title: "Status",
              render: (r) => <Badge status={r.status}>{r.status}</Badge>,
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
        open={open}
        onClose={() => setOpen(false)}
        title="Create commercial document"
        description="The server determines prices and taxes. Delivery notes reference stock already issued by their original sale."
        wide
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.run(
              () =>
                api("/documents", {
                  method: "POST",
                  body: clean({
                    ...form,
                    ...(customer ? { customer_id: customer.id } : {}),
                    ...(supplier ? { supplier_id: supplier.id } : {}),
                    lines: lines.map((l) => ({
                      product_id: l.product_id,
                      quantity: l.quantity,
                      serials: [],
                    })),
                  }),
                }),
              "Document created as a draft.",
            );
          }}
        >
          {action.error && <ErrorCard error={action.error} />}
          <Fields
            fields={[
              {
                key: "kind",
                label: "Document type",
                type: "select",
                required: true,
                options: [
                  { id: "quotation", name: "Quotation" },
                  {
                    id: "sales_order",
                    name: "Sales order (reservation on approval)",
                  },
                  {
                    id: "delivery_note",
                    name: "Delivery note for posted sale",
                  },
                  { id: "requisition", name: "Purchase requisition" },
                ],
              },
              {
                key: "branch_id",
                label: "Branch",
                type: "select",
                options: meta.branches,
                required: true,
              },
              {
                key: "warehouse_id",
                label: "Warehouse",
                type: "select",
                options: meta.warehouses,
                required:
                  form.kind === "sales_order" || form.kind === "requisition",
              },
              { key: "notes", label: "Notes", type: "textarea", full: true },
            ]}
            value={form}
            onChange={setForm}
          />
          {form.kind === "requisition" ? (
            <SearchSelect
              endpoint="/suppliers"
              label="Preferred supplier (optional)"
              value={supplier}
              onChange={setSupplier}
            />
          ) : (
            <SearchSelect
              endpoint="/customers"
              label="Customer (optional)"
              value={customer}
              onChange={setCustomer}
            />
          )}{" "}
          {form.kind === "delivery_note" && (
            <SearchSelect
              endpoint="/sales"
              label="Original posted sale"
              display="number"
              onChange={(s) => setForm({ ...form, sale_id: s?.id })}
            />
          )}
          <LineEditor lines={lines} onChange={setLines} />
          <div className="form-actions">
            <Button type="submit" busy={action.busy} disabled={!lines.length}>
              Create draft
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!detail && !transition && !convert}
        onClose={() => setDetail(null)}
        title={detail?.number ?? "Document"}
        description={detail?.kind?.replaceAll("_", " ")}
        wide
      >
        {detail && (
          <>
            <div className="detail-grid">
              <div>
                <span>Status</span>
                <Badge status={detail.status}>{detail.status}</Badge>
              </div>
              <div>
                <span>Total</span>
                <strong>{currency(detail.total, meta.company.currency)}</strong>
              </div>
            </div>
            <DataTable
              items={detail.lines}
              columns={[
                { key: "name", title: "Product / service" },
                {
                  key: "quantity",
                  title: "Quantity",
                  align: "right",
                  render: (r) => number(r.quantity),
                },
                {
                  key: "unit_price",
                  title: "Unit price",
                  align: "right",
                  render: (r) => currency(r.unit_price, meta.company.currency),
                },
                {
                  key: "total",
                  title: "Total",
                  align: "right",
                  render: (r) => currency(r.total, meta.company.currency),
                },
              ]}
            />
            <div className="form-actions">
              <a
                href={"/api/v1/print/document/" + detail.id}
                target="_blank"
                rel="noreferrer"
                className="btn secondary"
              >
                <Printer size={16} /> Print
              </a>
              {detail.status === "draft" && (
                <Button
                  onClick={() => {
                    setTransition("submitted");
                    setReason("");
                    review.setError(null);
                  }}
                >
                  Submit
                </Button>
              )}
              {detail.status === "submitted" &&
                actor.permissions.includes(
                  detail.kind === "requisition"
                    ? "purchases.approve"
                    : "sales.price_override",
                ) && (
                  <Button
                    onClick={() => {
                      setTransition("approved");
                      setReason("");
                      review.setError(null);
                    }}
                  >
                    Approve
                  </Button>
                )}
              {detail.status === "approved" && detail.kind === "quotation" && (
                <Button
                  onClick={() => {
                    setForm({
                      kind: "sales_order",
                      source_id: detail.id,
                      branch_id: detail.branch_id,
                      warehouse_id:
                        detail.warehouse_id ?? meta.warehouses[0]?.id,
                    });
                    setLines(
                      detail.lines.map((l: any) => ({
                        ...l,
                        product: { name: l.name, sku: "" },
                      })),
                    );
                    setDetail(null);
                    setOpen(true);
                  }}
                >
                  Convert to sales order
                </Button>
              )}
              {detail.status === "approved" &&
                detail.kind === "sales_order" && (
                  <Link
                    className="btn primary"
                    href={"/pos?order=" + detail.id}
                  >
                    Fulfil in POS <ArrowRight size={16} />
                  </Link>
                )}
              {detail.status === "approved" &&
                detail.kind === "requisition" && (
                  <Button
                    onClick={() => {
                      setConvert(true);
                      setSupplier(null);
                    }}
                  >
                    Convert to PO
                  </Button>
                )}
              {["draft", "submitted", "approved"].includes(detail.status) && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setTransition("cancelled");
                    setReason("");
                    review.setError(null);
                  }}
                >
                  Cancel with reason
                </Button>
              )}
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={!!transition}
        onClose={() => setTransition("")}
        title={`${transition} document`}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            review.run(
              () =>
                api(`/documents/${detail.id}/transition`, {
                  method: "POST",
                  body: { status: transition, reason },
                }),
              "Document state updated.",
            );
          }}
        >
          {review.error && <ErrorCard error={review.error} />}
          <FormField label="Reason" required>
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={5}
              required
            />
          </FormField>
          <div className="form-actions">
            <Button busy={review.busy} type="submit">
              Confirm {transition}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={convert}
        onClose={() => setConvert(false)}
        title="Convert requisition to PO"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            review.run(
              () =>
                api("/documents/" + detail.id + "/to-purchase-order", {
                  method: "POST",
                  body: { supplier_id: supplier?.id },
                }),
              "Linked purchase order created.",
            );
          }}
        >
          {review.error && <ErrorCard error={review.error} />}
          <SearchSelect
            endpoint="/suppliers"
            label="Supplier"
            value={supplier}
            onChange={setSupplier}
          />
          <div className="form-actions">
            <Button type="submit" busy={review.busy} disabled={!supplier}>
              Create purchase order
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
export function ExpensesPage() {
  const { meta, actor, branch } = useWorkspace(),
    list = useList("/expenses");
  const [open, setOpen] = useState(false),
    [form, setForm] = useState<any>({}),
    [detail, setDetail] = useState<any>(null),
    [mode, setMode] = useState(""),
    [reason, setReason] = useState(""),
    [payment, setPayment] = useState<any>({}),
    [attachment, setAttachment] = useState<File | null>(null);
  const [reclass, setReclass] = useState<any>({});
  const shifts = useQuery<any>(mode === "pay" ? "/shifts?limit=50" : null);
  const accounts = useQuery<any>(
    mode === "reclass" ? "/accounting/accounts" : null,
  );
  const receipts = useQuery<any>(
    detail ? `/expenses/${detail.id}/attachments` : null,
  );
  const action = useAction(() => {
    setOpen(false);
    setMode("");
    setDetail(null);
    list.refresh();
  });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      let file: any;
      if (attachment) {
        if (attachment.size > 5 * 1024 * 1024)
          throw new Error("Receipt attachments must be at most 5 MiB");
        const base64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1]);
          r.onerror = reject;
          r.readAsDataURL(attachment);
        });
        file = {
          filename: attachment.name,
          mime_type: attachment.type,
          base64,
        };
      }
      const result: any = await api("/expenses", {
        method: "POST",
        body: { ...clean(form), ...(file ? { attachment: file } : {}) },
      });
      return result;
    }, "Expense submitted for approval.");
  }
  return (
    <>
      <PageHeading
        eyebrow="FINANCE"
        title="Expenses"
        description="Request, approve and pay. Keep every expense tied to a voucher and a journal."
      >
        {actor.permissions.includes("expenses.create") && (
          <Button
            onClick={() => {
              setForm({
                branch_id: branch || meta.branches[0]?.id,
                category_id: meta.expense_categories[0]?.id,
                tax_rule_id: meta.tax_rules.find((t: any) => t.code === "VAT16")
                  ?.id,
                net: "0",
                description: "",
              });
              action.setError(null);
              setAttachment(null);
              setOpen(true);
            }}
          >
            <Plus size={17} /> Expense request
          </Button>
        )}
      </PageHeading>
      <section className="card">
        <div className="table-toolbar">
          <SearchBox value={list.search} onChange={list.setSearch} />
          <span className="muted">
            Approval limits and separation of duties are enforced.
          </span>
        </div>
        {list.error && <ErrorCard error={list.error} />}
        <DataTable
          items={list.data?.items}
          loading={list.loading}
          onRow={setDetail}
          columns={[
            {
              key: "number",
              title: "Voucher",
              render: (r) => <span className="reference-link">{r.number}</span>,
            },
            { key: "description", title: "Description" },
            { key: "category", title: "Category" },
            { key: "created_by_name", title: "Requested by" },
            {
              key: "accounting_date",
              title: "Date",
              render: (r) => dateText(r.accounting_date),
            },
            {
              key: "total",
              title: "Total",
              align: "right",
              render: (r) => currency(r.total, meta.company.currency),
            },
            {
              key: "status",
              title: "Status",
              render: (r) => <Badge status={r.status}>{r.status}</Badge>,
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
        open={open}
        onClose={() => setOpen(false)}
        title="Request an expense"
        description="The server calculates recoverable tax using the selected versioned rule."
        wide
      >
        <form onSubmit={submit}>
          {action.error && <ErrorCard error={action.error} />}
          <Fields
            fields={[
              {
                key: "branch_id",
                label: "Branch",
                type: "select",
                options: meta.branches,
                required: true,
              },
              {
                key: "category_id",
                label: "Expense category",
                type: "select",
                options: meta.expense_categories,
                required: true,
              },
              {
                key: "net",
                label: "Net amount (excluding tax)",
                type: "number",
                required: true,
              },
              {
                key: "tax_rule_id",
                label: "Tax category",
                type: "select",
                options: meta.tax_rules.filter((t: any) => t.active),
                required: true,
              },
              {
                key: "description",
                label: "Business purpose / description",
                type: "textarea",
                required: true,
                full: true,
              },
            ]}
            value={form}
            onChange={setForm}
          />
          <SearchSelect
            endpoint="/suppliers"
            label="Supplier / claimant (optional)"
            onChange={(s) => setForm({ ...form, supplier_id: s?.id })}
          />
          <FormField
            label="Receipt attachment"
            help="PNG, JPEG or PDF, maximum 5 MiB."
          >
            <input
              type="file"
              accept="image/png,image/jpeg,application/pdf"
              onChange={(e) => setAttachment(e.target.files?.[0] ?? null)}
            />
          </FormField>
          <div className="form-actions">
            <Button type="submit" busy={action.busy}>
              Submit expense request
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!detail && !mode}
        onClose={() => setDetail(null)}
        title={detail?.number ?? "Expense"}
        description={detail?.description}
      >
        <div className="detail-grid">
          <div>
            <span>Net expense</span>
            <strong>{currency(detail?.net, meta.company.currency)}</strong>
          </div>
          <div>
            <span>Recoverable tax</span>
            <strong>{currency(detail?.tax, meta.company.currency)}</strong>
          </div>
          <div>
            <span>Total</span>
            <strong>{currency(detail?.total, meta.company.currency)}</strong>
          </div>
          <div>
            <span>Status</span>
            <Badge status={detail?.status}>{detail?.status}</Badge>
          </div>
        </div>
        {detail?.status === "posted" && (
          <ExpenseRefundPanel expenseId={detail.id} onChanged={list.refresh} />
        )}
        <div className="form-actions">
          <a
            href={"/api/v1/print/expense/" + detail?.id}
            className="btn secondary"
            target="_blank"
            rel="noreferrer"
          >
            <Printer size={16} /> Voucher
          </a>
          {(receipts.data?.items ?? []).map((file: any) => (
            <a
              key={file.id}
              className="btn secondary"
              href={`/api/v1/attachments/${file.id}`}
              target="_blank"
              rel="noreferrer"
            >
              Receipt: {file.filename}
            </a>
          ))}
          {detail?.status === "submitted" &&
            actor.permissions.includes("expenses.approve") && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setMode("rejected");
                    setReason("");
                    action.setError(null);
                  }}
                >
                  Reject
                </Button>
                <Button
                  onClick={() => {
                    setMode("approved");
                    setReason("");
                    action.setError(null);
                  }}
                >
                  Approve
                </Button>
              </>
            )}
          {detail?.status === "approved" &&
            actor.permissions.includes("expenses.pay") && (
              <Button
                onClick={() => {
                  setMode("pay");
                  setPayment({
                    method_id: meta.payment_methods.find(
                      (m: any) => m.kind === "bank",
                    )?.id,
                    amount: detail.total,
                    reference: "",
                    shift_id: "",
                  });
                  action.setError(null);
                }}
              >
                <Wallet size={16} /> Pay & post
              </Button>
            )}
          {detail?.status === "posted" &&
            actor.permissions.includes("expenses.approve") && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setMode("reclass");
                    setReclass({ to_account_id: "", amount: detail.net });
                    setReason("");
                    action.setError(null);
                  }}
                >
                  Reclassify account
                </Button>
                {actor.permissions.includes("expenses.pay") && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setMode("void");
                      setReason("");
                      action.setError(null);
                    }}
                  >
                    Void erroneous entry
                  </Button>
                )}
              </>
            )}
        </div>
      </Dialog>
      <Dialog
        open={!!mode}
        onClose={() => setMode("")}
        title={
          mode === "pay"
            ? "Pay approved expense"
            : mode === "approved"
              ? "Approve expense"
              : mode === "void"
                ? "Void erroneous expense entry"
                : mode === "reclass"
                  ? "Reclassify posted expense"
                  : "Reject expense"
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.run(
              () =>
                mode === "pay"
                  ? api("/expenses/" + detail.id + "/pay", {
                      method: "POST",
                      body: {
                        payment: {
                          method_id: payment.method_id,
                          amount: payment.amount,
                          ...(payment.reference
                            ? { reference: payment.reference }
                            : {}),
                        },
                        ...(payment.shift_id
                          ? { shift_id: payment.shift_id }
                          : {}),
                      },
                    })
                  : mode === "void"
                    ? api("/expenses/" + detail.id + "/void", {
                        method: "POST",
                        body: { reason },
                      })
                    : mode === "reclass"
                      ? api("/expenses/" + detail.id + "/reclassify", {
                          method: "POST",
                          body: { ...reclass, reason },
                        })
                      : api("/expenses/" + detail.id + "/review", {
                          method: "POST",
                          body: { status: mode, reason },
                        }),
              mode === "pay"
                ? "Expense paid and journal posted."
                : mode === "void"
                  ? "Erroneous entry voided at its original date; register restored."
                  : mode === "reclass"
                    ? "Expense reclassified between accounts."
                    : "Expense approval state updated.",
            );
          }}
        >
          {action.error && <ErrorCard error={action.error} />}{" "}
          {mode === "pay" ? (
            <>
              <Fields
                fields={[
                  {
                    key: "method_id",
                    label: "Payment method",
                    type: "select",
                    options: meta.payment_methods.filter(
                      (m: any) => m.active && m.kind !== "mpesa",
                    ),
                    required: true,
                  },
                  { key: "reference", label: "Confirmed reference" },
                  {
                    key: "shift_id",
                    label: "Cash shift (required for cash)",
                    type: "select",
                    options:
                      shifts.data?.items
                        ?.filter(
                          (s: any) =>
                            s.branch_id === detail.branch_id &&
                            ["open", "rejected"].includes(s.status),
                        )
                        .map((s: any) => ({
                          id: s.id,
                          name: s.register + " · " + s.cashier,
                        })) ?? [],
                  },
                ]}
                value={payment}
                onChange={setPayment}
              />
              <div className="payment-balance">
                <span>Approved amount</span>
                <strong>{currency(detail.total, meta.company.currency)}</strong>
              </div>
            </>
          ) : mode === "void" ? (
            <>
              <p className="form-note">
                Use ONLY when the recorded transfer never actually happened
                (duplicate or wrong entry). The voucher, tender record and
                journals stay as immutable history; an exact reversal is
                appended at the original date and the register is restored.
                If money really moved back and forth, record an actual refund
                instead. Voiding needs approval authority and becomes
                impossible once refunds were issued.
              </p>
              <FormField label="Void explanation (audited)" required>
                <textarea
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  minLength={5}
                  required
                />
              </FormField>
            </>
          ) : mode === "reclass" ? (
            <>
              <p className="form-note">
                Moves part or all of the posted net between expense accounts.
                Tax, totals, tenders and profit stay untouched; a balanced
                journal is appended. Once you start, refunds and voids are
                locked for this voucher — reclassify fully back first if
                needed.
              </p>
              <Fields
                fields={[
                  {
                    key: "to_account_id",
                    label: "Move into expense account",
                    type: "select",
                    options: (accounts.data?.items ?? []).filter(
                      (a: any) => a.type === "expense" && a.active,
                    ),
                    required: true,
                  },
                  {
                    key: "amount",
                    label: "Amount (up to remaining posted net)",
                    type: "number",
                    required: true,
                  },
                ]}
                value={reclass}
                onChange={setReclass}
              />
              <FormField label="Reclassification reason (audited)" required>
                <textarea
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  minLength={5}
                  required
                />
              </FormField>
            </>
          ) : (
            <FormField label="Approval / rejection reason" required>
              <textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={5}
                required
              />
            </FormField>
          )}
          <div className="form-actions">
            <Button type="submit" busy={action.busy}>
              Confirm {mode === "pay" ? "payment" : mode}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
export function ShiftsPage() {
  const { meta, actor } = useWorkspace(),
    list = useList("/shifts");
  const [open, setOpen] = useState(false),
    [opening, setOpening] = useState<any>({}),
    [detail, setDetail] = useState<any>(null),
    [mode, setMode] = useState(""),
    [counts, setCounts] = useState<Record<string, string>>({}),
    [denoms, setDenoms] = useState<Record<string, number>>({}),
    [useDenoms, setUseDenoms] = useState(false),
    [reason, setReason] = useState(""),
    [cashForm, setCashForm] = useState<any>({});
  const action = useAction(() => {
    setOpen(false);
    setDetail(null);
    setMode("");
    list.refresh();
  });
  const values = [
    "0.5",
    "1",
    "5",
    "10",
    "20",
    "40",
    "50",
    "100",
    "200",
    "500",
    "1000",
  ];
  async function load(s: any) {
    action.setError(null);
    try {
      setDetail(await api("/shifts/" + s.id));
      setMode("");
    } catch (e) {
      action.setError(e);
    }
  }
  function beginClose() {
    setCounts(Object.fromEntries(detail.methods.map((m: any) => [m.id, "0"])));
    setDenoms({});
    setUseDenoms(false);
    setMode("close");
    action.setError(null);
  }
  function changeDenoms(d: Record<string, number>) {
    setDenoms(d);
    const total = Object.entries(d).reduce(
      (n, [v, q]) => n.plus(D(v).times(q)),
      D(0),
    );
    const cash = detail.methods.find((m: any) => m.kind === "cash");
    if (cash) setCounts((c) => ({ ...c, [cash.id]: money(total) }));
  }
  return (
    <>
      <PageHeading
        eyebrow="CASH CONTROL"
        title="Cashier shifts"
        description="Separate cash from non-cash. Count, explain and reconcile every till."
      >
        <Button
          onClick={() => {
            setOpening({
              register_id: meta.registers[0]?.id,
              opening_float: "0",
            });
            action.setError(null);
            setOpen(true);
          }}
        >
          <Plus size={17} /> Open shift
        </Button>
      </PageHeading>
      {action.error && !detail && !open && <ErrorCard error={action.error} />}
      <section className="card">
        <div className="table-toolbar">
          <SearchBox value={list.search} onChange={list.setSearch} />
          <span className="muted">
            Cash = float + cash tenders − cash refunds ± cash movements
          </span>
        </div>
        {list.error && <ErrorCard error={list.error} />}
        <DataTable
          loading={list.loading}
          items={list.data?.items}
          onRow={load}
          columns={[
            { key: "register", title: "Register" },
            { key: "cashier", title: "Cashier" },
            {
              key: "opened_at",
              title: "Opened",
              render: (r) => dateText(r.opened_at, true),
            },
            {
              key: "opening_float",
              title: "Opening float",
              align: "right",
              render: (r) => currency(r.opening_float, meta.company.currency),
            },
            {
              key: "closed_at",
              title: "Submitted",
              render: (r) => dateText(r.closed_at, true),
            },
            {
              key: "variance",
              title: "Cash variance",
              align: "right",
              render: (r) =>
                r.variance === null ? (
                  "—"
                ) : (
                  <strong
                    className={
                      D(r.variance).eq(0) ? "success-text" : "danger-text"
                    }
                  >
                    {currency(r.variance, meta.company.currency)}
                  </strong>
                ),
            },
            {
              key: "status",
              title: "Status",
              render: (r) => <Badge status={r.status}>{r.status}</Badge>,
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
        open={open}
        onClose={() => setOpen(false)}
        title="Open a cashier shift"
        description="Opening float is a physical count, not revenue or a new capital injection."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.run(
              () => api("/shifts/open", { method: "POST", body: opening }),
              "Shift opened.",
            );
          }}
        >
          {action.error && <ErrorCard error={action.error} />}
          <Fields
            fields={[
              {
                key: "register_id",
                label: "Register",
                type: "select",
                options: meta.registers,
                required: true,
              },
              {
                key: "opening_float",
                label: "Counted opening float",
                type: "number",
                required: true,
              },
            ]}
            value={opening}
            onChange={setOpening}
          />
          <div className="form-actions">
            <Button type="submit" busy={action.busy}>
              Open till
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!detail && !mode}
        onClose={() => setDetail(null)}
        title="Shift reconciliation"
        description={`Opened ${dateText(detail?.opened_at, true)} · ${detail?.status ?? ""}`}
        wide
      >
        {detail && (
          <>
            <div className="detail-grid">
              <div>
                <span>Opening float</span>
                <strong>
                  {currency(detail.opening_float, meta.company.currency)}
                </strong>
              </div>
              <div>
                <span>Expected physical cash</span>
                <strong>
                  {currency(detail.expected_cash, meta.company.currency)}
                </strong>
              </div>
              <div>
                <span>Cash variance</span>
                <strong>
                  {detail.variance !== null
                    ? currency(detail.variance, meta.company.currency)
                    : "Not counted"}
                </strong>
              </div>
            </div>
            <DataTable
              items={detail.methods}
              columns={[
                { key: "name", title: "Payment method" },
                { key: "kind", title: "Type" },
                {
                  key: "movement",
                  title: "Net confirmed tenders",
                  align: "right",
                  render: (r) => currency(r.movement, meta.company.currency),
                },
                {
                  key: "expected",
                  title: "Expected",
                  align: "right",
                  render: (r) => currency(r.expected, meta.company.currency),
                },
                {
                  key: "counted",
                  title: "Counted / statement",
                  align: "right",
                  render: (r) =>
                    detail.counts?.[r.id] !== undefined
                      ? currency(detail.counts[r.id], meta.company.currency)
                      : "—",
                },
              ]}
            />
            <div className="form-actions">
              {["open", "rejected"].includes(detail.status) &&
                detail.cashier_id === actor.id && (
                  <Button onClick={beginClose}>
                    <ClipboardCheck size={16} /> Count & submit
                  </Button>
                )}
              {["open", "rejected"].includes(detail.status) &&
                actor.permissions.includes("shifts.manage") && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setMode("cash");
                      setCashForm({
                        direction: "out",
                        amount: "0",
                        account_id: meta.accounts.find(
                          (a: any) => a.system_key === "bank",
                        )?.id,
                        reason: "",
                      });
                      action.setError(null);
                    }}
                  >
                    <ArrowLeftRight size={16} /> Cash movement
                  </Button>
                )}
              {detail.status === "submitted" &&
                actor.permissions.includes("shifts.review") && (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setMode("rejected");
                        setReason("");
                        action.setError(null);
                      }}
                    >
                      Reject for recount
                    </Button>
                    <Button
                      onClick={() => {
                        setMode("approved");
                        setReason("");
                        action.setError(null);
                      }}
                    >
                      Approve reconciliation
                    </Button>
                  </>
                )}
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={!!mode}
        onClose={() => setMode("")}
        title={
          mode === "close"
            ? "Count your closing balances"
            : mode === "cash"
              ? "Authorized cash movement"
              : mode === "approved"
                ? "Approve reconciliation"
                : "Reject for recount"
        }
        description={
          mode === "close"
            ? "Enter physical cash and actual statement totals independently. Non-cash variances must be resolved before approval."
            : "Sensitive actions require authority and an explanation."
        }
        wide
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.run(async () => {
              if (mode === "close") {
                let queue: any[] | undefined;
                try {
                  queue = await privateStore<any[]>("queue:" + actor.id);
                } catch {
                  throw new Error(
                    "Cannot verify this device’s private cash queue. Reconcile its captures before submitting the shift.",
                  );
                }
                if (queue?.some((q) => q.status !== "posted"))
                  throw new Error(
                    "Synchronize or reconcile this device’s unconfirmed cash captures before submitting the shift.",
                  );
              }
              return mode === "close"
                ? api("/shifts/" + detail.id + "/close", {
                    method: "POST",
                    body: {
                      counts,
                      ...(useDenoms ? { denominations: denoms } : {}),
                    },
                  })
                : mode === "cash"
                  ? api("/shifts/cash-movements", {
                      method: "POST",
                      body: { shift_id: detail.id, ...cashForm },
                    })
                  : api("/shifts/" + detail.id + "/review", {
                      method: "POST",
                      body: { status: mode, reason },
                    });
            }, "Shift workflow updated.");
          }}
        >
          {action.error && <ErrorCard error={action.error} />}{" "}
          {mode === "close" ? (
            <>
              <div className="form-grid">
                {detail.methods.map((m: any) => (
                  <FormField
                    key={m.id}
                    label={
                      m.name +
                      (m.kind === "cash"
                        ? " · physical cash"
                        : " · statement amount")
                    }
                  >
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={counts[m.id] ?? "0"}
                      onChange={(e) =>
                        setCounts((c) => ({ ...c, [m.id]: e.target.value }))
                      }
                    />
                  </FormField>
                ))}
              </div>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={useDenoms}
                  onChange={(e) => setUseDenoms(e.target.checked)}
                />{" "}
                Count cash by KES denomination
              </label>
              {useDenoms && (
                <div className="denomination-grid">
                  {values.map((v) => (
                    <FormField key={v} label={"KSh " + v}>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={denoms[v] ?? 0}
                        onChange={(e) =>
                          changeDenoms({
                            ...denoms,
                            [v]: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                      />
                    </FormField>
                  ))}
                </div>
              )}
            </>
          ) : mode === "cash" ? (
            <Fields
              fields={[
                {
                  key: "direction",
                  label: "Direction",
                  type: "select",
                  options: [
                    { id: "in", name: "Cash in" },
                    { id: "out", name: "Cash out" },
                  ],
                  required: true,
                },
                {
                  key: "amount",
                  label: "Amount",
                  type: "number",
                  required: true,
                },
                {
                  key: "account_id",
                  label: "Offset account (bank transfer / expense)",
                  type: "select",
                  options: meta.accounts.filter(
                    (a: any) =>
                      ![
                        "cash",
                        "mpesa",
                        "card",
                        "ar",
                        "ap",
                        "inventory",
                        "tax_output",
                        "tax_input",
                        "grni",
                        "customer_advances",
                        "supplier_advances",
                        "refund_payable",
                      ].includes(a.system_key),
                  ),
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
              value={cashForm}
              onChange={setCashForm}
            />
          ) : (
            <FormField label="Review reason" required>
              <textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={5}
                required
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
            <Button type="submit" busy={action.busy}>
              {mode === "close"
                ? "Submit counted shift"
                : mode === "cash"
                  ? "Post cash movement"
                  : "Confirm review"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
