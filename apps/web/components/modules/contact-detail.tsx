"use client";
import React, { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  PenLine,
  Check,
  Wallet,
  Printer,
  FileText,
  Gauge,
  CircleDollarSign,
  CalendarClock,
  Phone,
  FileDigit,
} from "lucide-react";
import {
  api,
  useWorkspace,
  currency,
  dateText,
  D,
  money,
  useQuery,
  download,
} from "../lib";
import {
  Button,
  Badge,
  PageHeading,
  DataTable,
  Pagination,
  ErrorCard,
  Fields,
  FormField,
  StatTile,
} from "../ui";
import { useAction, save, clean } from "./common";
import { contactFields } from "./contacts";

/** Full-page customer/supplier profile: editable account details, the
 * ledger-backed statement with print, and an inline payment initiation form. */
export function ContactDetailPage({
  kind,
  id,
}: {
  kind: "customer" | "supplier";
  id: string;
}) {
  const customer = kind === "customer";
  const { meta, actor, notify, branch } = useWorkspace();
  const resource = "/" + kind + "s";
  const perm = customer ? "customers" : "suppliers";
  const [dates, setDates] = useState({
    from: new Date().getFullYear() + "-01-01",
    to: new Date().toLocaleDateString("en-CA"),
  });
  const statement = useQuery<any>(
    `${resource}/${id}/statement?limit=100&from=${dates.from}&to=${dates.to}${branch ? "&branch_id=" + branch : ""}`,
  );
  const contact = statement.data?.contact;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<any>({});
  const fields = contactFields(customer);
  const edit = useAction(async () => {
    setEditing(false);
    statement.refresh();
  });
  function beginEdit() {
    edit.setError(null);
    setEditing(true);
    setForm(
      Object.fromEntries(fields.map((f) => [f.key, contact?.[f.key] ?? ""])),
    );
  }
  // payment initiation
  const [paying, setPaying] = useState(false);
  const [settlement, setSettlement] = useState<any>({});
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [openItemsPage, setOpenItemsPage] = useState(1);
  const openItems = useQuery<any>(
    paying
      ? `${resource}/${id}/open-items?limit=25&page=${openItemsPage}${settlement.branch_id ? "&branch_id=" + settlement.branch_id : ""}`
      : null,
  );
  const shifts = useQuery<any>(paying ? "/shifts?limit=50" : null);
  const canPay = actor.permissions.includes(
    customer ? "payments.receive" : "payments.pay",
  );
  const payAction = useAction(async () => {
    setPaying(false);
    statement.refresh();
  });
  function beginPayment() {
    if (!canPay) return;
    payAction.setError(null);
    setOpenItemsPage(1);
    const cash = meta.payment_methods.find((m: any) => m.kind === "cash");
    setSettlement({
      branch_id: branch || meta.branches[0]?.id,
      amount: "0",
      method_id: cash?.id ?? meta.payment_methods[0]?.id,
      reference: "",
      shift_id: "",
    });
    setAllocations({});
    setPaying(true);
  }
  async function pay(e: React.FormEvent) {
    e.preventDefault();
    await payAction.run(
      () =>
        api(resource + "/settlements", {
          method: "POST",
          body: {
            contact_id: id,
            branch_id: settlement.branch_id,
            payment: {
              method_id: settlement.method_id,
              amount: settlement.amount,
              ...(settlement.reference
                ? { reference: settlement.reference }
                : {}),
            },
            ...(settlement.shift_id ? { shift_id: settlement.shift_id } : {}),
            allocations: Object.entries(allocations)
              .filter(([_id, a]) => D(a || 0).gt(0))
              .map(([key, amount]) => {
                const [document_type, document_id] = key.includes(":")
                  ? key.split(":")
                  : ["invoice", key];
                return { document_type, document_id, amount };
              }),
          },
        }),
      customer
        ? "Customer receipt posted and allocated."
        : "Supplier payment posted and allocated.",
    );
  }
  const method = meta.payment_methods.find(
    (m: any) => m.id === settlement.method_id,
  );
  let allocated = D(0);
  try {
    allocated = Object.values(allocations).reduce(
      (a, v) => a.plus(v || 0),
      D(0),
    );
  } catch {}
  return (
    <>
      <PageHeading
        eyebrow={
          customer ? "RELATIONSHIPS · CUSTOMER" : "RELATIONSHIPS · SUPPLIER"
        }
        title={contact?.name ?? (customer ? "Customer" : "Supplier")}
        description={`${contact?.code ?? ""} · Account ledger and details`}
      >
        <Link href={resource} className="btn ghost">
          <ArrowLeft size={16} /> {customer ? "All customers" : "All suppliers"}
        </Link>
        {contact && !editing && actor.permissions.includes(perm + ".write") && (
          <Button variant="secondary" onClick={beginEdit}>
            <PenLine size={16} /> Edit details
          </Button>
        )}
        {contact && canPay && !paying && (
          <Button onClick={beginPayment}>
            <Wallet size={16} />
            {customer ? " Initiate receipt" : " Initiate payment"}
          </Button>
        )}
      </PageHeading>
      {statement.error && (
        <ErrorCard error={statement.error} retry={statement.refresh} />
      )}
      {contact && !editing && (
        <section className="card detail-header">
          <div className="stat-list">
            <StatTile
              icon={Wallet}
              tone={D(contact.balance).gt(0) ? "warn" : undefined}
              label={customer ? "Receivable" : "Payable"}
              value={currency(contact.balance, meta.company.currency)}
            />
            {customer && (
              <>
                <StatTile
                  icon={Gauge}
                  label="Credit limit"
                  value={currency(contact.credit_limit, meta.company.currency)}
                />
                <StatTile
                  icon={CircleDollarSign}
                  label="Available credit"
                  value={currency(
                    D(contact.credit_limit ?? 0).minus(contact.balance ?? 0),
                    meta.company.currency,
                  )}
                  tone={
                    D(contact.credit_limit ?? 0).gt(0) &&
                    D(contact.credit_limit ?? 0)
                      .minus(contact.balance ?? 0)
                      .lte(0)
                      ? "warn"
                      : undefined
                  }
                />
                {D(contact.discount_percent ?? 0).gt(0) && (
                  <StatTile
                    icon={CircleDollarSign}
                    label="Contract discount"
                    value={D(contact.discount_percent).toString() + "%"}
                  />
                )}
              </>
            )}
            <StatTile
              icon={CalendarClock}
              label="Payment terms"
              value={`${contact.credit_days} days`}
            />
            <StatTile
              icon={Phone}
              label="Contact"
              value={contact.phone || contact.email || "—"}
              sub={contact.phone && contact.email ? contact.email : undefined}
            />
            <StatTile
              icon={FileDigit}
              label="Tax PIN"
              value={contact.tax_pin || "—"}
            />
            <StatTile
              label="Status"
              value={
                <Badge status={contact.active ? "active" : "inactive"}>
                  {contact.active ? "Active" : "Inactive"}
                </Badge>
              }
            />
          </div>
          {contact.address && <p className="muted">{contact.address}</p>}
        </section>
      )}
      {contact && editing && (
        <section className="card form-card">
          <h3>
            <PenLine size={16} /> Edit {kind} details
          </h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              edit.run(
                () =>
                  save(
                    resource,
                    {
                      ...clean(form),
                      credit_days: Number(form.credit_days ?? 30),
                    },
                    id,
                  ),
                customer ? "Customer updated." : "Supplier updated.",
              );
            }}
          >
            {edit.error && <ErrorCard error={edit.error} />}
            <Fields fields={fields} value={form} onChange={setForm} />
            <div className="form-actions">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button busy={edit.busy} type="submit">
                <Check size={16} /> Save {kind}
              </Button>
            </div>
          </form>
        </section>
      )}
      {paying && (
        <section className="card form-card">
          <h3>
            <Wallet size={17} />
            {customer ? " Receive customer payment" : " Pay supplier"}
          </h3>
          <p className="form-note">
            Allocate to {contact?.name} invoices. Excess is held as an unapplied
            advance.
          </p>
          <form onSubmit={pay}>
            {payAction.error && <ErrorCard error={payAction.error} />}
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
                  key: "method_id",
                  label: "Payment method",
                  type: "select",
                  options: meta.payment_methods.filter(
                    (m: any) => m.active && m.kind !== "mpesa",
                  ),
                  required: true,
                },
                {
                  key: "amount",
                  label: "Total payment amount",
                  type: "number",
                  required: true,
                },
                {
                  key: "reference",
                  label: "Confirmed payment reference",
                  required: method?.requires_reference,
                },
              ]}
              value={settlement}
              onChange={(v) => {
                if (v.branch_id !== settlement.branch_id) {
                  setAllocations({});
                  setOpenItemsPage(1);
                }
                setSettlement(v);
              }}
            />
            {method?.kind === "cash" && (
              <FormField label="Cash shift" required>
                <select
                  value={settlement.shift_id}
                  required
                  onChange={(e) =>
                    setSettlement({ ...settlement, shift_id: e.target.value })
                  }
                >
                  <option value="">Select an open shift</option>
                  {shifts.data?.items
                    ?.filter(
                      (s: any) =>
                        ["open", "rejected"].includes(s.status) &&
                        s.branch_id === settlement.branch_id,
                    )
                    .map((s: any) => (
                      <option key={s.id} value={s.id}>
                        {s.register} · {s.cashier}
                      </option>
                    ))}
                </select>
              </FormField>
            )}
            <h4 className="subheading">Allocate to outstanding invoices</h4>
            {openItems.error && <ErrorCard error={openItems.error} />}
            <div className="allocation-list">
              {openItems.data?.items
                ?.filter((i: any) => D(i.outstanding).gt(0))
                .map((i: any) => (
                  <div key={i.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={
                          !!allocations[
                            (i.document_type ?? "invoice") + ":" + i.id
                          ]
                        }
                        onChange={(e) => {
                          setAllocations((a) => {
                            const n = { ...a };
                            if (e.target.checked)
                              n[(i.document_type ?? "invoice") + ":" + i.id] =
                                money(i.outstanding);
                            else
                              delete n[
                                (i.document_type ?? "invoice") + ":" + i.id
                              ];
                            return n;
                          });
                        }}
                      />
                      <strong>
                        {i.document_type === "opening" ? "Opening · " : ""}
                        {i.number}
                      </strong>
                      <small>Due {dateText(i.due_date)}</small>
                    </label>
                    <span>
                      {currency(i.outstanding, meta.company.currency)}
                    </span>
                    <input
                      aria-label={"Allocation to " + i.number}
                      type="number"
                      min="0"
                      step="0.01"
                      value={
                        allocations[
                          (i.document_type ?? "invoice") + ":" + i.id
                        ] ?? ""
                      }
                      placeholder="0.00"
                      onChange={(e) =>
                        setAllocations((a) => ({
                          ...a,
                          [(i.document_type ?? "invoice") + ":" + i.id]:
                            e.target.value,
                        }))
                      }
                    />
                  </div>
                ))}
              {!openItems.data?.items?.length && (
                <p className="form-note">
                  No open invoices. This payment will be an unapplied advance.
                </p>
              )}
            </div>
            <Pagination
              page={openItemsPage}
              total={openItems.data?.total ?? 0}
              onChange={setOpenItemsPage}
            />
            <div className="payment-balance">
              <span>Allocated</span>
              <strong>{currency(allocated, meta.company.currency)}</strong>
            </div>
            <div className="form-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPaying(false)}
              >
                Cancel
              </Button>
              <Button busy={payAction.busy} type="submit">
                <Check size={16} />
                {customer ? " Post receipt" : " Post payment"}
              </Button>
            </div>
          </form>
        </section>
      )}
      <section className="card">
        <div className="table-toolbar">
          <h3>
            <FileText size={17} />
            {customer
              ? " Customer ledger / statement"
              : " Supplier ledger / statement"}
          </h3>
          <div className="toolbar-filters">
            <div className="date-filter">
              <input
                type="date"
                aria-label="Statement start"
                value={dates.from}
                onChange={(e) => setDates({ ...dates, from: e.target.value })}
              />
              <span>to</span>
              <input
                type="date"
                aria-label="Statement end"
                value={dates.to}
                onChange={(e) => setDates({ ...dates, to: e.target.value })}
              />
            </div>
            {contact && (
              <Button
                variant="secondary"
                onClick={() =>
                  download(
                    `${resource}/${id}/statement?format=pdf&from=${dates.from}&to=${dates.to}`,
                    "statement.pdf",
                  ).catch((e) => notify(e.message, "error"))
                }
              >
                <Printer size={15} /> Print statement
              </Button>
            )}
          </div>
        </div>
        {statement.data && (
          <div className="balance-chips">
            <div className="balance-chip">
              <span>Opening balance</span>
              <strong>
                {currency(statement.data.opening, meta.company.currency)}
              </strong>
            </div>
            <ArrowRight size={14} aria-hidden />
            <div className="balance-chip">
              <span>Closing balance</span>
              <strong>
                {currency(
                  statement.data.items?.length
                    ? statement.data.items[statement.data.items.length - 1]
                        .balance
                    : statement.data.opening,
                  meta.company.currency,
                )}
              </strong>
            </div>
          </div>
        )}
        <DataTable
          loading={statement.loading}
          items={statement.data?.items}
          columns={[
            {
              key: "accounting_date",
              title: "Date",
              render: (r) => dateText(r.accounting_date),
            },
            { key: "number", title: "Journal" },
            { key: "description", title: "Description" },
            {
              key: "debit",
              title: "Debit",
              align: "right",
              render: (r) => currency(r.debit, meta.company.currency),
            },
            {
              key: "credit",
              title: "Credit",
              align: "right",
              render: (r) => currency(r.credit, meta.company.currency),
            },
            {
              key: "balance",
              title: "Balance",
              align: "right",
              render: (r) => currency(r.balance, meta.company.currency),
            },
          ]}
        />
      </section>
    </>
  );
}
