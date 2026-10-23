"use client";
import React, { useState } from "react";
import Link from "next/link";
import { Plus, PenLine } from "lucide-react";
import { useWorkspace, currency, D } from "../lib";
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
  type FieldDef,
} from "../ui";
import { useList, useAction, save, clean } from "./common";

export function contactFields(customer: boolean): FieldDef[] {
  return [
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
}

/** Customers / suppliers list. Each account row links to its own page
 * (/customers/:id or /suppliers/:id) holding the details editor, the
 * ledger-backed statement and inline payment initiation. */
export function ContactsPage({ kind }: { kind: "customer" | "supplier" }) {
  const customer = kind === "customer";
  const { meta, actor } = useWorkspace();
  const resource = "/" + kind + "s",
    perm = customer ? "customers" : "suppliers";
  const list = useList(resource);
  const [editing, setEditing] = useState<any>(null),
    [form, setForm] = useState<any>({});
  const fields = contactFields(customer);
  const action = useAction(() => {
    setEditing(null);
    list.refresh();
  });
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
                <Link
                  className="cell-button customer-cell"
                  href={resource + "/" + r.id}
                >
                  <span className="mini-avatar">{r.name[0]}</span>
                  <span>
                    <strong>{r.name}</strong>
                    <small>{r.code}</small>
                  </span>
                </Link>
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
              render: (r) =>
                actor.permissions.includes(perm + ".write") ? (
                  <div className="table-actions">
                    <button
                      className="icon-btn"
                      aria-label={"Edit " + r.name}
                      onClick={() => edit(r)}
                    >
                      <PenLine size={16} />
                    </button>
                  </div>
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
    </>
  );
}
