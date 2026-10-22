"use client";
import React, { useState } from "react";
import {
  Plus,
  ArrowUpRight,
  Wallet,
  FileText,
  PenLine,
  Printer,
  Check,
  Users,
  Building2,
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
  download,
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
  type FieldDef,
} from "../ui";
import { useList, useAction, save, clean } from "./common";
export function ContactsPage({ kind }: { kind: "customer" | "supplier" }) {
  const customer = kind === "customer";
  const { meta, actor, branch, notify } = useWorkspace();
  const resource = "/" + kind + "s",
    perm = customer ? "customers" : "suppliers";
  const list = useList(resource);
  const [editing, setEditing] = useState<any>(null),
    [form, setForm] = useState<any>({}),
    [selected, setSelected] = useState<any>(null),
    [payment, setPayment] = useState(false),
    [openItemsPage, setOpenItemsPage] = useState(1),
    [settlement, setSettlement] = useState<any>({}),
    [allocations, setAllocations] = useState<Record<string, string>>({}),
    [statementDates, setStatementDates] = useState({
      from: new Date().getFullYear() + "-01-01",
      to: new Date().toLocaleDateString("en-CA"),
    });
  const [customerPrice, setCustomerPrice] = useState(false),
    [priceProduct, setPriceProduct] = useState<any>(null),
    [priceForm, setPriceForm] = useState({ price: "0", min_quantity: "1" });
  const statement = useQuery<any>(
    selected && !payment
      ? `${resource}/${selected.id}/statement?limit=100&from=${statementDates.from}&to=${statementDates.to}${branch ? "&branch_id=" + branch : ""}`
      : null,
  );
  const openItems = useQuery<any>(
    selected && payment
      ? `${resource}/${selected.id}/open-items?limit=25&page=${openItemsPage}${settlement.branch_id ? "&branch_id=" + settlement.branch_id : ""}`
      : null,
  );
  const shifts = useQuery<any>(payment ? "/shifts?limit=50" : null);
  const action = useAction(() => {
    setEditing(null);
    list.refresh();
  });
  const payAction = useAction(() => {
    setPayment(false);
    list.refresh();
    statement.refresh();
  });
  const priceAction = useAction(() => setCustomerPrice(false));
  const fields: FieldDef[] = [
    {
      key: "name",
      label: customer ? "Customer name" : "Supplier / company name",
      required: true,
      full: true,
    },
    { key: "code", label: "Account code", required: true },
    { key: "phone", label: "Phone number" },
    { key: "email", label: "Email address", type: "email" },
    { key: "tax_pin", label: "Tax PIN" },
    {
      key: "credit_days",
      label: "Payment terms (days)",
      type: "number",
      step: "1",
      min: "0",
    },
    ...(customer
      ? ([
          { key: "credit_limit", label: "Credit limit", type: "number" },
          {
            key: "discount_percent",
            label: "Contract discount (%)",
            type: "number",
            max: "100",
          },
        ] as FieldDef[])
      : []),
    { key: "address", label: "Address", type: "textarea", full: true },
    { key: "active", label: "Account active", type: "checkbox" },
  ];
  function edit(v?: any) {
    action.setError(null);
    setEditing(v ?? {});
    setForm(
      v
        ? Object.fromEntries(fields.map((f) => [f.key, v[f.key] ?? ""]))
        : {
            name: "",
            code: "",
            credit_days: "30",
            credit_limit: "0",
            discount_percent: "0",
            active: true,
          },
    );
  }
  function beginPayment() {
    setOpenItemsPage(1);
    payAction.setError(null);
    const cash = meta.payment_methods.find((m: any) => m.kind === "cash");
    setSettlement({
      branch_id: branch || meta.branches[0]?.id,
      amount: "0",
      method_id: cash?.id ?? meta.payment_methods[0]?.id,
      reference: "",
      shift_id: "",
    });
    setAllocations({});
    setPayment(true);
  }
  async function pay(e: React.FormEvent) {
    e.preventDefault();
    await payAction.run(
      () =>
        api(resource + "/settlements", {
          method: "POST",
          body: {
            contact_id: selected.id,
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
        eyebrow="RELATIONSHIPS"
        title={customer ? "Customers" : "Suppliers"}
        description={
          customer
            ? "Build lasting relationships. Keep every balance and receipt connected."
            : "Your purchasing partners, outstanding balances and payment history."
        }
      >
        {actor.permissions.includes(perm + ".write") && (
          <Button onClick={() => edit()}>
            <Plus size={17} /> Add {kind}
          </Button>
        )}
      </PageHeading>
      <section className="card">
        <div className="table-toolbar">
          <SearchBox
            value={list.search}
            onChange={list.setSearch}
            placeholder={`Search ${kind} name, code or phone…`}
          />
          <span className="muted">
            {list.data?.total ?? 0} {kind} accounts
          </span>
        </div>
        {list.error && <ErrorCard error={list.error} />}
        <DataTable
          items={list.data?.items}
          loading={list.loading}
          columns={[
            {
              key: "name",
              title: customer ? "Customer" : "Supplier",
              render: (r) => (
                <button
                  className="cell-button customer-cell"
                  onClick={() => {
                    setSelected(r);
                    setPayment(false);
                  }}
                >
                  <span className="mini-avatar">{r.name[0]}</span>
                  <span>
                    <strong>{r.name}</strong>
                    <small>{r.code}</small>
                  </span>
                </button>
              ),
            },
            { key: "phone", title: "Phone" },
            {
              key: "credit_days",
              title: "Terms",
              render: (r) => r.credit_days + " days",
            },
            ...(customer
              ? [
                  {
                    key: "credit_limit",
                    title: "Credit limit",
                    align: "right" as const,
                    render: (r: any) =>
                      currency(r.credit_limit, meta.company.currency),
                  },
                ]
              : []),
            {
              key: "balance",
              title: customer ? "Receivable" : "Payable",
              align: "right",
              render: (r) => (
                <strong className={D(r.balance).gt(0) ? "warning-text" : ""}>
                  {currency(r.balance, meta.company.currency)}
                </strong>
              ),
            },
            {
              key: "active",
              title: "Status",
              render: (r) => (
                <Badge status={r.active ? "active" : "inactive"}>
                  {r.active ? "Active" : "Inactive"}
                </Badge>
              ),
            },
            {
              key: "actions",
              title: "",
              render: (r) => (
                <div className="table-actions">
                  <button
                    className="icon-btn"
                    aria-label={"Statement for " + r.name}
                    onClick={() => {
                      setSelected(r);
                      setPayment(false);
                    }}
                  >
                    <FileText size={16} />
                  </button>
                  {actor.permissions.includes(perm + ".write") && (
                    <button
                      className="icon-btn"
                      aria-label={"Edit " + r.name}
                      onClick={() => edit(r)}
                    >
                      <PenLine size={16} />
                    </button>
                  )}
                </div>
              ),
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
        title={(editing?.id ? "Edit " : "Add ") + kind}
        description="Credit limits, tax details and account terms are validated on the server."
        wide
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.run(() =>
              save(
                resource,
                { ...clean(form), credit_days: Number(form.credit_days ?? 30) },
                editing.id,
              ),
            );
          }}
        >
          {action.error && <ErrorCard error={action.error} />}
          <Fields fields={fields} value={form} onChange={setForm} />
          <div className="form-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
            <Button busy={action.busy} type="submit">
              Save {kind}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!selected && !payment}
        onClose={() => setSelected(null)}
        title={selected?.name ?? "Account statement"}
        description={`${selected?.code ?? ""} · Ledger-backed statement. Debit-positive balances; advances appear separately.`}
        wide
      >
        <div className="detail-grid">
          <div>
            <span>
              {customer ? "Outstanding receivable" : "Outstanding payable"}
            </span>
            <strong>
              {currency(selected?.balance, meta.company.currency)}
            </strong>
          </div>
          <div>
            <span>Payment terms</span>
            <strong>{selected?.credit_days} days</strong>
          </div>
        </div>
        <div className="table-toolbar">
          <div className="date-filter">
            <input
              type="date"
              aria-label="Statement start"
              value={statementDates.from}
              onChange={(e) =>
                setStatementDates({ ...statementDates, from: e.target.value })
              }
            />
            <span>to</span>
            <input
              type="date"
              aria-label="Statement end"
              value={statementDates.to}
              onChange={(e) =>
                setStatementDates({ ...statementDates, to: e.target.value })
              }
            />
          </div>
          <Button
            variant="secondary"
            onClick={() =>
              download(
                `${resource}/${selected.id}/statement?format=pdf&from=${statementDates.from}&to=${statementDates.to}`,
                "statement.pdf",
              ).catch((e) => notify(e.message, "error"))
            }
          >
            <Printer size={15} /> Print
          </Button>
        </div>
        {statement.error && <ErrorCard error={statement.error} />}
        <div className="muted statement-opening">
          Opening balance:{" "}
          {currency(statement.data?.opening, meta.company.currency)}
        </div>
        <DataTable
          items={statement.data?.items}
          loading={statement.loading}
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
        <div className="form-actions">
          {actor.permissions.includes(perm + ".write") && (
            <Button
              variant="secondary"
              onClick={() => {
                edit(selected);
              }}
            >
              <PenLine size={16} /> Edit details
            </Button>
          )}
          {actor.permissions.includes(
            customer ? "payments.receive" : "payments.pay",
          ) && (
            <Button onClick={beginPayment}>
              <Wallet size={16} />
              {customer ? "Receive payment" : "Pay supplier"}
            </Button>
          )}
        </div>
      </Dialog>
      <Dialog
        open={payment}
        onClose={() => setPayment(false)}
        title={customer ? "Receive customer payment" : "Pay supplier"}
        description={`Allocate to ${selected?.name ?? ""} invoices. Excess is held as an unapplied advance.`}
        wide
      >
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
          <h3 className="subheading">Allocate to outstanding invoices</h3>
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
                  <span>{currency(i.outstanding, meta.company.currency)}</span>
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
          <p className="form-note">
            Allocations selected on other pages are included in the total.
          </p>
          <div className="payment-balance">
            <span>Allocated</span>
            <strong>{currency(allocated, meta.company.currency)}</strong>
          </div>
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setPayment(false)}
            >
              Cancel
            </Button>
            <Button
              busy={payAction.busy}
              type="submit"
              disabled={openItems.loading}
            >
              Post {customer ? "receipt" : "payment"} <Check size={16} />
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
