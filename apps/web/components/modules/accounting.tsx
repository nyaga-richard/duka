"use client";
import { OpeningBalancesPanel } from "./opening-balances";
import React, { useState } from "react";
import {
  Plus,
  Printer,
  BookOpen,
  CheckCheck,
  RotateCcw,
  ArrowDownToLine,
  CalendarDays,
  ShieldCheck,
  Check,
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
  scopedQuery,
  rangeDates,
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
  type Column,
} from "../ui";
import { useList, useAction, clean } from "./common";
export function AccountingPage() {
  const { meta, actor, branch, reloadMeta } = useWorkspace();
  const [tab, setTab] = useState("journals"),
    [mode, setMode] = useState(""),
    [detail, setDetail] = useState<any>(null),
    [form, setForm] = useState<any>({}),
    [lines, setLines] = useState<any[]>([]),
    [selectedLines, setSelectedLines] = useState<string[]>([]);
  const shifts = useQuery<any>(
    mode === "dispose" || mode === "asset" ? "/shifts?limit=50" : null,
  );
  const list = useList(
    tab === "opening"
      ? null
      : tab === "journals"
        ? "/accounting/journals"
        : tab === "accounts"
          ? "/accounting/accounts"
          : tab === "assets"
            ? "/accounting/assets"
            : tab === "banks"
              ? "/accounting/bank-reconciliations"
              : "/accounting/budgets",
  );
  const trial = useQuery<any>(
    tab === "trial"
      ? "/reports/trial-balance?" + scopedQuery({}, branch)
      : null,
  );
  const unmatched = useQuery<any>(
    mode === "bank" && form.account_id
      ? "/accounting/bank-unmatched?account_id=" +
          form.account_id +
          "&to=" +
          form.statement_date +
          "&limit=100"
      : null,
  );
  const action = useAction(async () => {
    setMode("");
    setDetail(null);
    list.refresh();
    trial.refresh();
    await reloadMeta();
  });
  const control = [
    "inventory",
    "ar",
    "ap",
    "grni",
    "customer_advances",
    "supplier_advances",
    "refund_payable",
  ];
  const available =
    meta.accounts?.filter((a: any) => !control.includes(a.system_key)) ?? [];
  async function loadJournal(j: any) {
    action.setError(null);
    try {
      setDetail(await api("/accounting/journals/" + j.id));
    } catch (e) {
      action.setError(e);
    }
  }
  function journal() {
    setMode("journal");
    action.setError(null);
    setForm({
      branch_id: branch || meta.branches[0]?.id,
      accounting_date: new Date().toLocaleDateString("en-CA"),
      description: "",
      reason: "",
    });
    setLines([
      { account_id: available[0]?.id, debit: "0", credit: "0" },
      { account_id: available[1]?.id, debit: "0", credit: "0" },
    ]);
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await action.run(
      () =>
        mode === "journal"
          ? api("/accounting/journals", {
              method: "POST",
              body: { ...form, lines },
            })
          : mode === "reverse"
            ? api("/accounting/journals/" + detail.id + "/reverse", {
                method: "POST",
                body: form,
              })
            : mode === "account"
              ? api("/accounting/accounts", { method: "POST", body: form })
              : mode === "period"
                ? api("/accounting/periods", { method: "POST", body: form })
                : mode === "period-status"
                  ? api("/accounting/periods/" + detail.id + "/status", {
                      method: "POST",
                      body: form,
                    })
                  : mode === "asset"
                    ? api("/accounting/assets", {
                        method: "POST",
                        body: {
                          branch_id: form.branch_id,
                          name: form.name,
                          cost: form.cost,
                          residual: form.residual,
                          useful_months: Number(form.useful_months),
                          acquired_date: form.acquired_date,
                          funding: form.funding === "payment" ? "payment" : "opening",
                          ...(form.funding === "payment"
                            ? {
                                tax: form.tax || "0",
                                payment: {
                                  method_id: form.method_id,
                                  ...(form.reference
                                    ? { reference: form.reference }
                                    : {}),
                                },
                                ...(form.shift_id
                                  ? { shift_id: form.shift_id }
                                  : {}),
                              }
                            : {}),
                        },
                      })
                    : mode === "dispose"
                      ? api("/accounting/assets/" + detail.id + "/dispose", {
                          method: "POST",
                          body: {
                            proceeds: form.proceeds ?? "0",
                            reason: form.reason,
                            accounting_date: form.accounting_date,
                            ...(Number(form.proceeds) > 0
                              ? {
                                  payment: {
                                    method_id: form.method_id,
                                    ...(form.reference
                                      ? { reference: form.reference }
                                      : {}),
                                  },
                                  ...(form.shift_id
                                    ? { shift_id: form.shift_id }
                                    : {}),
                                }
                              : {}),
                          },
                        })
                      : mode === "depreciate"
                      ? api("/accounting/assets/" + detail.id + "/depreciate", {
                          method: "POST",
                          body: form,
                        })
                      : mode === "budget"
                        ? api("/accounting/budgets", {
                            method: "POST",
                            body: form,
                          })
                        : api("/accounting/bank-reconciliations", {
                            method: "POST",
                            body: { ...form, journal_line_ids: selectedLines },
                          }),
      "Accounting workflow committed and audited.",
    );
  }
  function begin(mode: string, data: any) {
    action.setError(null);
    setForm(data);
    setMode(mode);
  }
  const headings: Record<string, string> = {
    journal: "Post a balanced manual journal",
    reverse: "Reverse this manual journal",
    account: "Add an account",
    period: "Create accounting period",
    "period-status": "Change period state",
    asset: "Register a fixed asset (opening or paid acquisition)",
    depreciate: "Post monthly depreciation",
    dispose: "Dispose of this fixed asset",
    budget: "Set a branch budget",
    bank: "Reconcile bank or clearing account",
  };
  let dr = D(0),
    cr = D(0);
  for (const l of lines) {
    try {
      dr = dr.plus(l.debit || 0);
      cr = cr.plus(l.credit || 0);
    } catch {}
  }
  const rows =
    tab === "periods"
      ? meta.periods
      : tab === "trial"
        ? trial.data?.items
        : list.data?.items;
  const columns: Column[] =
    tab === "journals"
      ? [
          {
            key: "number",
            title: "Journal",
            render: (r) => (
              <button
                className="cell-button reference-link"
                onClick={() => loadJournal(r)}
              >
                {r.number}
              </button>
            ),
          },
          {
            key: "accounting_date",
            title: "Date",
            render: (r) => dateText(r.accounting_date),
          },
          {
            key: "source_type",
            title: "Source",
            render: (r) => <Badge>{r.source_type.replaceAll("_", " ")}</Badge>,
          },
          { key: "description", title: "Description" },
          {
            key: "total",
            title: "Balanced value",
            align: "right",
            render: (r) => currency(r.total, meta.company.currency),
          },
          { key: "created_by_name", title: "Posted by" },
          {
            key: "state",
            title: "State",
            render: (r) => (
              <Badge status={r.reversed_by ? "cancelled" : "posted"}>
                {r.reversed_by
                  ? "Reversed"
                  : r.reversal_of
                    ? "Reversal"
                    : "Posted"}
              </Badge>
            ),
          },
        ]
      : tab === "trial"
        ? [
            { key: "code", title: "Code" },
            { key: "name", title: "Account" },
            { key: "type", title: "Type" },
            {
              key: "debits",
              title: "Debits",
              align: "right",
              render: (r) => currency(r.debits, meta.company.currency),
            },
            {
              key: "credits",
              title: "Credits",
              align: "right",
              render: (r) => currency(r.credits, meta.company.currency),
            },
            {
              key: "balance",
              title: "Net debit balance",
              align: "right",
              render: (r) => (
                <strong>{currency(r.balance, meta.company.currency)}</strong>
              ),
            },
          ]
        : tab === "accounts"
          ? [
              { key: "code", title: "Code" },
              { key: "name", title: "Account" },
              { key: "type", title: "Type" },
              {
                key: "system_key",
                title: "Integration key",
                render: (r) =>
                  r.system_key ? <code>{r.system_key}</code> : "Custom account",
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
            ]
          : tab === "periods"
            ? [
                { key: "name", title: "Period" },
                {
                  key: "start_date",
                  title: "From",
                  render: (r) => dateText(r.start_date),
                },
                {
                  key: "end_date",
                  title: "To",
                  render: (r) => dateText(r.end_date),
                },
                {
                  key: "status",
                  title: "State",
                  render: (r) => <Badge status={r.status}>{r.status}</Badge>,
                },
                {
                  key: "action",
                  title: "",
                  render: (r) =>
                    actor.permissions.includes("accounting.close") ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setDetail(r);
                          begin("period-status", {
                            status: r.status === "open" ? "closed" : "open",
                            reason: "",
                          });
                        }}
                      >
                        {r.status === "open" ? "Close" : "Reopen"} period
                      </Button>
                    ) : null,
                },
              ]
            : tab === "assets"
              ? [
                  { key: "name", title: "Fixed asset" },
                  {
                    key: "acquired_date",
                    title: "Acquired",
                    render: (r) => dateText(r.acquired_date),
                  },
                  {
                    key: "cost",
                    title: "Cost",
                    align: "right",
                    render: (r) => currency(r.cost, meta.company.currency),
                  },
                  {
                    key: "depreciated",
                    title: "Depreciated",
                    align: "right",
                    render: (r) =>
                      currency(r.depreciated, meta.company.currency),
                  },
                  {
                    key: "carrying",
                    title: "Carrying amount",
                    align: "right",
                    render: (r) =>
                      currency(
                        D(r.cost).minus(r.depreciated),
                        meta.company.currency,
                      ),
                  },
                  {
                    key: "status",
                    title: "State",
                    render: (r) => <Badge status={r.status}>{r.status}</Badge>,
                  },
                  {
                    key: "action",
                    title: "",
                    render: (r) =>
                      r.status === "active" ? (
                        <div className="form-actions" style={{ margin: 0 }}>
                          <Button
                            variant="secondary"
                            onClick={() => {
                              setDetail(r);
                              begin("depreciate", {
                                accounting_date: new Date().toLocaleDateString(
                                  "en-CA",
                                ),
                              });
                            }}
                          >
                            Depreciate
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setDetail(r);
                              begin("dispose", {
                                proceeds: "0",
                                reason: "",
                                accounting_date:
                                  new Date().toLocaleDateString("en-CA"),
                                method_id: meta.payment_methods.find(
                                  (m: any) => m.kind === "bank",
                                )?.id,
                                reference: "",
                                shift_id: "",
                              });
                            }}
                          >
                            Dispose
                          </Button>
                        </div>
                      ) : null,
                  },
                ]
              : tab === "banks"
                ? [
                    { key: "account", title: "Account" },
                    {
                      key: "statement_date",
                      title: "Statement date",
                      render: (r) => dateText(r.statement_date),
                    },
                    {
                      key: "statement_balance",
                      title: "Confirmed balance",
                      align: "right",
                      render: (r) =>
                        currency(r.statement_balance, meta.company.currency),
                    },
                    {
                      key: "status",
                      title: "State",
                      render: (r) => (
                        <Badge status={r.status}>{r.status}</Badge>
                      ),
                    },
                  ]
                : [
                    { key: "branch", title: "Branch" },
                    { key: "account", title: "Account" },
                    { key: "period", title: "Period" },
                    {
                      key: "amount",
                      title: "Budget",
                      align: "right",
                      render: (r) => currency(r.amount, meta.company.currency),
                    },
                    {
                      key: "actual",
                      title: "Actual expense",
                      align: "right",
                      render: (r) => currency(r.actual, meta.company.currency),
                    },
                    {
                      key: "remaining",
                      title: "Remaining",
                      align: "right",
                      render: (r) =>
                        currency(
                          D(r.amount).minus(r.actual),
                          meta.company.currency,
                        ),
                    },
                  ];
  return (
    <>
      <PageHeading
        eyebrow="THE BOOKS"
        title="Accounting"
        description="Real double-entry. Immutable journals. A clear view of the numbers."
      >
        {actor.permissions.includes("accounting.post") && (
          <Button onClick={journal}>
            <Plus size={17} /> Manual journal
          </Button>
        )}
      </PageHeading>
      <div className="page-tabs">
        {[
          ["journals", "Journal entries"],
          ["trial", "Trial balance"],
          ["accounts", "Chart of accounts"],
          ["periods", "Periods"],
          ["opening", "Opening balances"],
          ["assets", "Fixed assets"],
          ["banks", "Bank reconciliation"],
          ["budgets", "Budgets"],
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
      {tab === "trial" && trial.data && (
        <div className="accounting-balance-strip">
          <CheckCheck size={23} />
          <div>
            <strong>
              {trial.data.balanced
                ? "Your trial balance is balanced."
                : "A difference requires investigation."}
            </strong>
            <span>
              Debits {currency(trial.data.debits, meta.company.currency)} =
              Credits {currency(trial.data.credits, meta.company.currency)}
            </span>
          </div>
          <Badge status={trial.data.balanced ? "successful" : "failed"}>
            Difference {currency(trial.data.difference, meta.company.currency)}
          </Badge>
        </div>
      )}
      {tab === "opening" ? (
        <OpeningBalancesPanel />
      ) : (
        <section className="card">
          <div className="table-toolbar">
            <SearchBox
              value={list.search}
              onChange={list.setSearch}
              placeholder="Search accounting records…"
            />
            <div className="toolbar-filters">
              {tab === "trial" && (
                <a
                  href={
                    "/api/v1/reports/trial-balance?format=pdf&" +
                    scopedQuery({}, branch)
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="btn secondary"
                >
                  <Printer size={16} /> Print trial balance
                </a>
              )}
              {actor.permissions.includes("accounting.post") &&
                tab === "accounts" && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      begin("account", { code: "", name: "", type: "expense" })
                    }
                  >
                    <Plus size={16} /> Account
                  </Button>
                )}
              {actor.permissions.includes("accounting.close") &&
                tab === "periods" && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      begin("period", {
                        name: "",
                        start_date: "",
                        end_date: "",
                      })
                    }
                  >
                    <Plus size={16} /> Period
                  </Button>
                )}
              {actor.permissions.includes("accounting.post") &&
                tab === "assets" && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      begin("asset", {
                        branch_id: branch || meta.branches[0]?.id,
                        name: "",
                        cost: "0",
                        residual: "0",
                        useful_months: "36",
                        acquired_date: new Date().toLocaleDateString("en-CA"),
                        funding: "opening",
                        tax: "0",
                        method_id: meta.payment_methods.find(
                          (m: any) => m.kind === "bank",
                        )?.id,
                        reference: "",
                        shift_id: "",
                      })
                    }
                  >
                    <Plus size={16} /> Asset
                  </Button>
                )}
              {actor.permissions.includes("accounting.post") &&
                tab === "banks" && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSelectedLines([]);
                      begin("bank", {
                        account_id: meta.accounts.find(
                          (a: any) => a.system_key === "bank",
                        )?.id,
                        statement_date: new Date().toLocaleDateString("en-CA"),
                        statement_balance: "0",
                      });
                    }}
                  >
                    Reconcile statement
                  </Button>
                )}
              {actor.permissions.includes("accounting.post") &&
                tab === "budgets" && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      begin("budget", {
                        branch_id: branch || meta.branches[0]?.id,
                        account_id: meta.accounts.find(
                          (a: any) => a.type === "expense",
                        )?.id,
                        period_id: meta.periods.find(
                          (p: any) => p.status === "open",
                        )?.id,
                        amount: "0",
                      })
                    }
                  >
                    <Plus size={16} /> Set budget
                  </Button>
                )}
            </div>
          </div>
          {(list.error || trial.error) && (
            <ErrorCard error={tab === "trial" ? trial.error : list.error} />
          )}
          <DataTable
            items={rows}
            columns={columns}
            loading={
              tab === "trial"
                ? trial.loading
                : tab === "periods"
                  ? false
                  : list.loading
            }
          />
          {!["trial", "periods", "accounts"].includes(tab) && (
            <Pagination
              page={list.page}
              total={list.data?.total ?? 0}
              onChange={list.setPage}
            />
          )}
        </section>
      )}

      <Dialog
        open={!!detail && !mode && tab === "journals"}
        onClose={() => setDetail(null)}
        title={detail?.number ?? "Journal"}
        description={detail?.description}
        wide
      >
        {detail && (
          <>
            <DataTable
              items={detail.lines}
              columns={[
                { key: "code", title: "Code" },
                { key: "account", title: "Account" },
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
              ]}
            />
            <p className="form-note">
              Source {detail.source_type} · Immutable once posted. Business
              transactions must be corrected through their own return or
              credit-note workflow.
            </p>
            <div className="form-actions">
              {["manual", "opening"].includes(detail.source_type) &&
                !detail.reversal_of &&
                actor.permissions.includes("accounting.reverse") && (
                  <Button
                    variant="danger"
                    onClick={() =>
                      begin("reverse", {
                        accounting_date: new Date().toLocaleDateString("en-CA"),
                        reason: "",
                      })
                    }
                  >
                    <RotateCcw size={16} /> Reverse with reason
                  </Button>
                )}
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={!!mode}
        onClose={() => setMode("")}
        title={headings[mode] ?? "Accounting"}
        description={
          mode === "journal"
            ? "Operational control accounts must use their domain workflows. Posted entries cannot be changed."
            : mode === "asset"
              ? "This workflow posts an opening asset against owner equity; do not use it to duplicate a purchased asset."
              : mode === "bank"
                ? "Match all historical bank movements up to the statement date. Matched cumulative balance must equal the statement."
                : "All changes are permission-checked and audited."
        }
        wide
      >
        <form onSubmit={submit}>
          {action.error && <ErrorCard error={action.error} />}
          <Fields
            fields={
              mode === "journal"
                ? [
                    {
                      key: "branch_id",
                      label: "Branch",
                      type: "select",
                      options: meta.branches,
                      required: true,
                    },
                    {
                      key: "accounting_date",
                      label: "Accounting date",
                      type: "date",
                      required: true,
                    },
                    {
                      key: "description",
                      label: "Description",
                      required: true,
                      full: true,
                    },
                    {
                      key: "reason",
                      label: "Business reason",
                      type: "textarea",
                      required: true,
                      full: true,
                    },
                  ]
                : mode === "reverse"
                  ? [
                      {
                        key: "accounting_date",
                        label: "Reversal accounting date",
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
                    ]
                  : mode === "account"
                    ? [
                        { key: "code", label: "Account code", required: true },
                        { key: "name", label: "Account name", required: true },
                        {
                          key: "type",
                          label: "Account type",
                          type: "select",
                          options: [
                            "asset",
                            "liability",
                            "equity",
                            "income",
                            "expense",
                          ].map((id) => ({ id, name: id })),
                          required: true,
                        },
                      ]
                    : mode === "period"
                      ? [
                          { key: "name", label: "Period name", required: true },
                          {
                            key: "start_date",
                            label: "Start date",
                            type: "date",
                            required: true,
                          },
                          {
                            key: "end_date",
                            label: "End date",
                            type: "date",
                            required: true,
                          },
                        ]
                      : mode === "period-status"
                        ? [
                            {
                              key: "reason",
                              label: `Reason to ${form.status === "closed" ? "close" : "reopen"} this period`,
                              type: "textarea",
                              required: true,
                              full: true,
                            },
                          ]
                        : mode === "asset"
                          ? [
                              {
                                key: "branch_id",
                                label: "Branch",
                                type: "select",
                                options: meta.branches,
                                required: true,
                              },
                              {
                                key: "name",
                                label: "Asset name",
                                required: true,
                              },
                              {
                                key: "funding",
                                label: "Acquisition channel",
                                type: "select",
                                options: [
                                  { id: "opening", name: "Opening balance (against equity)" },
                                  { id: "payment", name: "Paid now (real tender out)" },
                                ],
                                required: true,
                              },
                              {
                                key: "cost",
                                label: "Asset cost (book value)",
                                type: "number",
                                required: true,
                              },
                              {
                                key: "residual",
                                label: "Residual value",
                                type: "number",
                                required: true,
                              },
                              {
                                key: "useful_months",
                                label: "Useful life (months)",
                                type: "number",
                                step: "1",
                                min: "1",
                                required: true,
                              },
                              {
                                key: "acquired_date",
                                label: "Acquisition date",
                                type: "date",
                                required: true,
                              },
                              ...(form.funding === "payment"
                                ? ([
                                    {
                                      key: "tax",
                                      label: "Recoverable input VAT",
                                      type: "number",
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
                                    { key: "reference", label: "Transfer/cheque reference" },
                                    {
                                      key: "shift_id",
                                      label: "Cash shift (required for cash)",
                                      type: "select",
                                      options:
                                        shifts.data?.items
                                          ?.filter((s: any) =>
                                            ["open", "rejected"].includes(s.status),
                                          )
                                          .map((s: any) => ({
                                            id: s.id,
                                            name: s.register + " · " + s.cashier,
                                          })) ?? [],
                                    },
                                  ] as any[])
                                : []),
                            ]
                          : mode === "depreciate"
                            ? [
                                {
                                  key: "accounting_date",
                                  label: "Depreciation accounting date",
                                  type: "date",
                                  required: true,
                                },
                              ]
                            : mode === "dispose"
                              ? [
                                  {
                                    key: "proceeds",
                                    label: "Sale proceeds (0 = scrapped)",
                                    type: "number",
                                    required: true,
                                  },
                                  {
                                    key: "accounting_date",
                                    label: "Disposal date",
                                    type: "date",
                                    required: true,
                                  },
                                  ...(Number(form.proceeds) > 0
                                    ? ([
                                        {
                                          key: "method_id",
                                          label: "Proceeds received via",
                                          type: "select",
                                          options: meta.payment_methods.filter(
                                            (m: any) =>
                                              m.active && m.kind !== "mpesa",
                                          ),
                                          required: true,
                                        },
                                        {
                                          key: "reference",
                                          label: "Transfer/cheque reference",
                                        },
                                        {
                                          key: "shift_id",
                                          label: "Cash shift (required for cash)",
                                          type: "select",
                                          options:
                                            shifts.data?.items
                                              ?.filter((s: any) =>
                                                ["open", "rejected"].includes(
                                                  s.status,
                                                ),
                                              )
                                              .map((s: any) => ({
                                                id: s.id,
                                                name:
                                                  s.register + " · " + s.cashier,
                                              })) ?? [],
                                        },
                                      ] as any[])
                                    : []),
                                  {
                                    key: "reason",
                                    label: "Disposal reason (audited)",
                                    required: true,
                                  },
                                ]
                            : mode === "budget"
                              ? [
                                  {
                                    key: "branch_id",
                                    label: "Branch",
                                    type: "select",
                                    options: meta.branches,
                                    required: true,
                                  },
                                  {
                                    key: "account_id",
                                    label: "Expense account",
                                    type: "select",
                                    options: meta.accounts.filter(
                                      (a: any) => a.type === "expense",
                                    ),
                                    required: true,
                                  },
                                  {
                                    key: "period_id",
                                    label: "Period",
                                    type: "select",
                                    options: meta.periods,
                                    required: true,
                                  },
                                  {
                                    key: "amount",
                                    label: "Budget amount",
                                    type: "number",
                                    required: true,
                                  },
                                ]
                              : [
                                  {
                                    key: "account_id",
                                    label: "Bank or clearing account",
                                    type: "select",
                                    options: meta.accounts.filter((a: any) =>
                                      [
                                        "bank",
                                        "cash",
                                        "mpesa",
                                        "card",
                                      ].includes(a.system_key),
                                    ),
                                    required: true,
                                  },
                                  {
                                    key: "statement_date",
                                    label: "Statement date",
                                    type: "date",
                                    required: true,
                                  },
                                  {
                                    key: "statement_balance",
                                    label: "Actual ending statement balance",
                                    required: true,
                                  },
                                ]
            }
            value={form}
            onChange={setForm}
          />
          {mode === "journal" && (
            <>
              <div className="journal-editor">
                {lines.map((l, i) => (
                  <div className="journal-edit-line" key={i}>
                    <FormField label="Account">
                      <select
                        value={l.account_id}
                        onChange={(e) =>
                          setLines(
                            lines.map((x, j) =>
                              i === j
                                ? { ...x, account_id: e.target.value }
                                : x,
                            ),
                          )
                        }
                      >
                        {available.map((a: any) => (
                          <option key={a.id} value={a.id}>
                            {a.code} · {a.name}
                          </option>
                        ))}
                      </select>
                    </FormField>
                    <FormField label="Debit">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={l.debit}
                        onChange={(e) =>
                          setLines(
                            lines.map((x, j) =>
                              i === j
                                ? {
                                    ...x,
                                    debit: e.target.value || "0",
                                    credit: "0",
                                  }
                                : x,
                            ),
                          )
                        }
                      />
                    </FormField>
                    <FormField label="Credit">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={l.credit}
                        onChange={(e) =>
                          setLines(
                            lines.map((x, j) =>
                              i === j
                                ? {
                                    ...x,
                                    credit: e.target.value || "0",
                                    debit: "0",
                                  }
                                : x,
                            ),
                          )
                        }
                      />
                    </FormField>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Remove journal line"
                      onClick={() => setLines(lines.filter((_, j) => i !== j))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setLines([
                    ...lines,
                    { account_id: available[0]?.id, debit: "0", credit: "0" },
                  ])
                }
              >
                <Plus size={16} /> Add line
              </Button>
              <div className="payment-balance">
                <span>
                  Debits {currency(dr, meta.company.currency)} · Credits{" "}
                  {currency(cr, meta.company.currency)}
                </span>
                <Badge status={dr.eq(cr) ? "successful" : "failed"}>
                  {dr.eq(cr) ? "Balanced" : "Unbalanced"}
                </Badge>
              </div>
            </>
          )}
          {mode === "bank" && (
            <>
              {unmatched.error && <ErrorCard error={unmatched.error} />}
              <DataTable
                items={unmatched.data?.items}
                columns={[
                  {
                    key: "select",
                    title: "Match",
                    render: (r) => (
                      <input
                        type="checkbox"
                        aria-label={"Match " + r.number}
                        checked={selectedLines.includes(r.id)}
                        onChange={(e) =>
                          setSelectedLines((v) =>
                            e.target.checked
                              ? [...v, r.id]
                              : v.filter((id) => id !== r.id),
                          )
                        }
                      />
                    ),
                  },
                  { key: "number", title: "Journal" },
                  {
                    key: "accounting_date",
                    title: "Date",
                    render: (r) => dateText(r.accounting_date),
                  },
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
                ]}
              />
              <p className="form-note">
                This screen lists the first 100 unmatched lines. Reconcile
                sequential statements rather than loading your entire ledger
                into the browser.
              </p>
            </>
          )}
          <div className="form-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setMode("")}
            >
              Cancel
            </Button>
            <Button
              busy={action.busy}
              type="submit"
              disabled={mode === "journal" && (!dr.eq(cr) || dr.eq(0))}
            >
              Confirm & post <Check size={16} />
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
const reportNames = [
  ["sales", "Sales analysis"],
  ["pnl", "Profit & loss"],
  ["balance-sheet", "Balance sheet"],
  ["trial-balance", "Trial balance"],
  ["gl", "General ledger"],
  ["cash-flow", "Cash movements"],
  ["ar-aging", "Receivables aging"],
  ["ap-aging", "Payables aging"],
  ["tax", "Tax summary"],
  ["valuation", "Inventory valuation"],
];
export function ReportsPage() {
  const { meta, branch, notify } = useWorkspace();
  const [name, setName] = useState("sales"),
    [dates, setDates] = useState(rangeDates("month")),
    [group, setGroup] = useState("product"),
    [warehouse, setWarehouse] = useState(""),
    [page, setPage] = useState(1),
    [account, setAccount] = useState("");
  const q = scopedQuery(
    {
      ...dates,
      page,
      limit: 25,
      ...(name === "sales" ? { group } : {}),
      warehouse_id: warehouse || undefined,
      account_id: account || undefined,
    },
    branch,
  );
  const r = useQuery<any>("/reports/" + name + "?" + q);
  const data = r.data;
  const rows =
    data?.items ??
    (data?.income
      ? [...data.income, ...data.expenses]
      : data?.assets
        ? [...data.assets, ...data.liabilities, ...data.equity]
        : []);
  const numeric = new Set([
    "revenue",
    "tax",
    "total",
    "cost",
    "gross_profit",
    "debit",
    "credit",
    "debits",
    "credits",
    "balance",
    "amount",
    "outstanding",
    "running_balance",
    "value",
    "average_cost",
    "net",
    "inflows",
    "outflows",
    "taxable_base",
    "output_tax",
  ]);
  const keys = rows[0]
    ? Object.keys(rows[0]).filter(
        (k) =>
          ![
            "id",
            "company_id",
            "journal_id",
            "account_id",
            "customer_id",
            "supplier_id",
            "source_id",
            "branch_id",
            "contact_id",
            "warehouse_id",
            "system_key",
            "memo",
            "created_at",
          ].includes(k),
      )
    : [];
  const columns: Column[] = keys.map((k) => ({
    key: k,
    title: k.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    align: numeric.has(k) || k === "quantity" ? "right" : "left",
    render: (v) =>
      numeric.has(k)
        ? currency(v[k], meta.company.currency)
        : k.endsWith("date")
          ? dateText(v[k])
          : k === "quantity"
            ? number(v[k])
            : String(v[k] ?? "—"),
  }));
  const metrics =
    name === "pnl"
      ? [
          ["Revenue", data?.revenue],
          ["Gross profit", data?.gross_profit],
          ["Net profit", data?.net_profit],
        ]
      : name === "balance-sheet"
        ? [
            ["Assets", data?.total_assets],
            ["Liabilities", data?.total_liabilities],
            ["Equity + current earnings", data?.total_equity],
          ]
        : name === "trial-balance"
          ? [
              ["Debits", data?.debits],
              ["Credits", data?.credits],
              ["Difference", data?.difference],
            ]
          : name === "tax"
            ? [
                ["Input VAT", data?.input_tax],
                ["Output VAT", data?.output_tax],
                ["Net VAT", data?.net_tax],
              ]
            : name === "cash-flow"
              ? [
                  ["Opening cash", data?.opening],
                  ["Net movement", data?.net_movement],
                  ["Closing cash", data?.closing],
                ]
              : [];
  return (
    <>
      <PageHeading
        eyebrow="INSIGHT & RECONCILIATION"
        title="Reports"
        description="Clear answers, backed by the same records that run your business."
      >
        <Button
          variant="secondary"
          onClick={() =>
            download(
              "/reports/" + name + "?" + q + "&format=csv",
              name + ".csv",
            ).catch((e) => notify(e.message, "error"))
          }
        >
          <ArrowDownToLine size={16} /> Export current page
        </Button>
        {["pnl", "balance-sheet", "trial-balance"].includes(name) && (
          <a
            className="btn secondary"
            href={"/api/v1/reports/" + name + "?" + q + "&format=pdf"}
            target="_blank"
            rel="noreferrer"
          >
            <Printer size={16} /> Print PDF
          </a>
        )}
      </PageHeading>
      <div className="report-layout">
        <aside className="report-menu">
          {reportNames.map(([id, label]) => (
            <button
              key={id}
              className={name === id ? "active" : ""}
              onClick={() => {
                setName(id);
                setPage(1);
              }}
            >
              <BookOpen size={16} />
              {label}
            </button>
          ))}
        </aside>
        <section>
          <div className="card report-filters">
            <FormField label="From date">
              <input
                type="date"
                value={dates.from}
                onChange={(e) => {
                  setDates({ ...dates, from: e.target.value });
                  setPage(1);
                }}
              />
            </FormField>
            <FormField label="To / as-of date">
              <input
                type="date"
                value={dates.to}
                onChange={(e) => {
                  setDates({ ...dates, to: e.target.value });
                  setPage(1);
                }}
              />
            </FormField>
            {name === "sales" && (
              <FormField label="Group sales by">
                <select
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  {["product", "category", "customer", "cashier", "branch"].map(
                    (g) => (
                      <option key={g} value={g}>
                        {g[0].toUpperCase() + g.slice(1)}
                      </option>
                    ),
                  )}
                </select>
              </FormField>
            )}
            {name === "valuation" && (
              <FormField label="Warehouse">
                <select
                  value={warehouse}
                  onChange={(e) => setWarehouse(e.target.value)}
                >
                  <option value="">All assigned locations</option>
                  {meta.warehouses.map((w: any) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </FormField>
            )}
            {name === "gl" && (
              <FormField label="Account">
                <select
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                >
                  <option value="">All accounts</option>
                  {meta.accounts?.map((a: any) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </FormField>
            )}
          </div>
          {metrics.length > 0 && (
            <div className="report-metrics">
              {metrics.map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{currency(value, meta.company.currency)}</strong>
                </div>
              ))}
            </div>
          )}
          <section className="card">
            <div className="card-heading">
              <div>
                <h2>{reportNames.find(([id]) => id === name)?.[1]}</h2>
                <p>
                  {[
                    "balance-sheet",
                    "trial-balance",
                    "ar-aging",
                    "ap-aging",
                    "valuation",
                  ].includes(name)
                    ? "As of " + dates.to
                    : dates.from + " → " + dates.to}{" "}
                  ·{" "}
                  {branch
                    ? meta.branches.find((b: any) => b.id === branch)?.name
                    : "All assigned branches"}
                </p>
              </div>
              {data?.balanced !== undefined && (
                <Badge status={data.balanced ? "successful" : "failed"}>
                  {data.balanced ? "Balanced" : "Difference detected"}
                </Badge>
              )}
            </div>
            {r.error && <ErrorCard error={r.error} retry={r.refresh} />}
            <DataTable
              items={rows}
              loading={r.loading}
              columns={
                columns.length
                  ? columns
                  : [{ key: "name", title: "Report data" }]
              }
            />
            {data?.total !== undefined && (
              <Pagination page={page} total={data.total} onChange={setPage} />
            )}{" "}
            {data?.note && <p className="report-note">{data.note}</p>}
            {name === "balance-sheet" && data && (
              <div className="report-note">
                Current earnings included in equity:{" "}
                {currency(data.current_earnings, meta.company.currency)} ·
                Balance sheet difference:{" "}
                {currency(data.difference, meta.company.currency)}
              </div>
            )}
          </section>
        </section>
      </div>
    </>
  );
}
