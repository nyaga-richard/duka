"use client";
import React, { useState, useEffect } from "react";
import { openingBatchSchema, openingItemSchema } from "@duka/shared";
import {
  api,
  useWorkspace,
  useQuery,
  currency,
  dateText,
  D,
  draftDecimal,
} from "../lib";
import {
  Button,
  Dialog,
  FormField,
  ErrorCard,
  DataTable,
  Badge,
  SearchBox,
  Pagination,
} from "../ui";
import { useList, useAction, parseCsv, clean } from "./common";
const blank = () => ({
  kind: "customer",
  direction: "debt",
  contact_code: "",
  reference: "",
  original_date: "",
  due_date: "",
  amount: "",
  description: "",
});
export function OpeningBalancesPanel() {
  const { actor, meta, branch } = useWorkspace(),
    list = useList("/accounting/opening-batches");
  const [selected, setSelected] = useState<string | null>(null),
    [editId, setEditId] = useState<string | null>(null),
    [edit, setEdit] = useState(false),
    [form, setForm] = useState<any>({}),
    [items, setItems] = useState<any[]>([]),
    [csv, setCsv] = useState(""),
    [localError, setLocalError] = useState<any>(null),
    [review, setReview] = useState(""),
    [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [creditItem, setCreditItem] = useState<any>(null),
    [creditId, setCreditId] = useState(""),
    [creditAmount, setCreditAmount] = useState(""),
    [creditPage, setCreditPage] = useState(1);
  const detail = useQuery<any>(
      selected ? "/accounting/opening-batches/" + selected : null,
    ),
    policy = useQuery<any>(
      edit && form.branch_id
        ? "/accounting/opening-metadata?branch_id=" + form.branch_id
        : null,
    );
  const credits = useQuery<any>(
    creditItem
      ? `/payments/advances?branch_id=${detail.data?.branch_id}&contact_id=${creditItem.customer_id ?? creditItem.supplier_id}&page=${creditPage}&limit=25`
      : null,
  );
  const action = useAction((result) => {
    setEdit(false);
    setReview("");
    setCreditItem(null);
    setReason("");
    list.refresh();
    if (result?.items) setSelected(result.id);
    detail.refresh();
  });
  useEffect(() => {
    if (policy.data?.suggested_cutover)
      setForm((old: any) =>
        old.accounting_date
          ? old
          : { ...old, accounting_date: policy.data.suggested_cutover },
      );
  }, [policy.data]);
  function start(data?: any) {
    action.setError(null);
    setLocalError(null);
    setEditId(data?.id ?? null);
    setForm(
      data
        ? {
            branch_id: data.branch_id,
            accounting_date:
              dateText(data.accounting_date) === "—"
                ? ""
                : String(data.accounting_date).slice(0, 10),
            reference: data.reference,
            notes: data.notes,
          }
        : {
            branch_id: branch || meta.branches[0]?.id,
            accounting_date: "",
            reference: "",
            notes: "",
          },
    );
    setItems(
      data?.items.map((i: any) => ({
        kind: i.kind,
        contact_code: i.contact_code,
        reference: i.reference,
        original_date: i.original_date
          ? String(i.original_date).slice(0, 10)
          : "",
        due_date: String(i.due_date).slice(0, 10),
        amount: i.amount,
        description: i.description,
      })) ?? [blank()],
    );
    setCsv("");
    setEdit(true);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setLocalError(null);
    try {
      const body = openingBatchSchema.parse({
        ...form,
        items: items.map(clean),
      });
      await action.run(
        () =>
          api("/accounting/opening-batches" + (editId ? "/" + editId : ""), {
            method: editId ? "PUT" : "POST",
            body,
          }),
        "Unposted opening draft saved; no sale, tax, stock or cash was generated.",
      );
    } catch (error) {
      setLocalError(error);
    }
  }
  function loadCsv() {
    try {
      const rows = parseCsv(csv);
      if (rows.length > 500)
        throw new Error(
          "Split migration files into batches of at most500 items",
        );
      setItems(rows.map((row) => openingItemSchema.parse(clean(row))));
      setLocalError(null);
      setCsv("");
    } catch (error) {
      setLocalError(error);
    }
  }
  function beginReview(mode: string) {
    setReason("");
    setConfirmed(false);
    action.setError(null);
    setReview(mode);
  }
  async function doReview(event: React.FormEvent) {
    event.preventDefault();
    const id = detail.data.id;
    await action.run(
      () =>
        api(
          `/accounting/opening-batches/${id}/${review === "post" ? "post" : review === "reverse" ? "reverse" : "transition"}`,
          {
            method: "POST",
            body:
              review === "post" || review === "reverse"
                ? { reason }
                : { status: review, reason },
          },
        ),
      "Opening workflow recorded; original financial history was not rewritten.",
    );
  }
  async function applyCredit(event: React.FormEvent) {
    event.preventDefault();
    await action.run(
      () =>
        api(`/accounting/opening-items/${creditItem.id}/apply-credit`, {
          method: "POST",
          body: { credit_id: creditId, amount: creditAmount, reason },
        }),
      "Previously booked credit allocated; no new cash payment occurred.",
    );
  }
  const ar = items
      .filter((i) => i.kind === "customer" && i.direction !== "credit")
      .reduce((sum, i) => sum.plus(draftDecimal(i.amount)), D(0)),
    ap = items
      .filter((i) => i.kind === "supplier" && i.direction !== "credit")
      .reduce((sum, i) => sum.plus(draftDecimal(i.amount)), D(0)),
    ca = items
      .filter((i) => i.kind === "customer" && i.direction === "credit")
      .reduce((sum, i) => sum.plus(draftDecimal(i.amount)), D(0)),
    sa = items
      .filter((i) => i.kind === "supplier" && i.direction === "credit")
      .reduce((sum, i) => sum.plus(draftDecimal(i.amount)), D(0)),
    b = detail.data;
  return (
    <>
      <section className="card">
        <div className="table-toolbar">
          <SearchBox
            value={list.search}
            onChange={list.setSearch}
            placeholder="Search opening batch or source ledger…"
          />
          {actor.permissions.includes("accounting.post") && (
            <Button onClick={() => start()}>Import opening balances</Button>
          )}
        </div>
        <p className="form-note" style={{ padding: "0 22px" }}>
          Carry forward outstanding legacy invoices and party advance credits
          against opening equity, never fictitious sales/purchases or VAT.
          Import only balances not already recorded here. Cutover must precede
          this branch’s operating debt activity and becomes fixed on first
          approval. Imported advances become real allocatable customer/supplier
          credits; consumed ones can never be reversed away.
        </p>
        {list.error && <ErrorCard error={list.error} />}
        <DataTable
          loading={list.loading}
          items={list.data?.items}
          onRow={(row) => {
            setSelected(row.id);
            action.setError(null);
          }}
          columns={[
            { key: "number", title: "Batch" },
            { key: "reference", title: "Source ledger" },
            {
              key: "accounting_date",
              title: "Cutover",
              render: (r) => dateText(r.accounting_date),
            },
            {
              key: "total",
              title: "Gross approval value",
              align: "right",
              render: (r) => currency(r.total, meta.company.currency),
            },
            {
              key: "state",
              title: "State",
              render: (r) => <Badge status={r.state}>{r.state}</Badge>,
            },
            { key: "created_by_name", title: "Prepared by" },
          ]}
        />
        <Pagination
          page={list.page}
          total={list.data?.total ?? 0}
          onChange={list.setPage}
        />
      </section>
      <Dialog
        open={!!selected && !edit && !review && !creditItem}
        onClose={() => setSelected(null)}
        title={b?.number ?? "Opening batch"}
        description="Original legacy references and carry-forward debt, not a new fiscal invoice."
        wide
      >
        {detail.error && <ErrorCard error={detail.error} />}{" "}
        {action.error && <ErrorCard error={action.error} />}{" "}
        {b && (
          <>
            <div className="detail-grid">
              <div>
                <span>Cutover</span>
                <strong>{dateText(b.accounting_date)}</strong>
              </div>
              <div>
                <span>Source</span>
                <strong>{b.reference}</strong>
              </div>
              <div>
                <span>Opening receivables</span>
                <strong>
                  {currency(b.receivables, meta.company.currency)}
                </strong>
              </div>
              <div>
                <span>Opening payables</span>
                <strong>{currency(b.payables, meta.company.currency)}</strong>
              </div>
              <div>
                <span>Legacy customer advances</span>
                <strong>
                  {currency(b.customer_credits, meta.company.currency)}
                </strong>
              </div>
              <div>
                <span>Legacy supplier advances</span>
                <strong>
                  {currency(b.supplier_credits, meta.company.currency)}
                </strong>
              </div>
              <div>
                <span>State</span>
                <Badge status={b.state}>{b.state}</Badge>
              </div>
            </div>
            <DataTable
              items={b.items}
              columns={[
                { key: "kind", title: "Ledger" },
                {
                  key: "direction",
                  title: "Direction",
                  render: (r) =>
                    r.direction === "credit" ? (
                      <Badge status="posted">advance credit</Badge>
                    ) : (
                      <Badge status="draft">debt</Badge>
                    ),
                },
                { key: "contact", title: "Party" },
                { key: "reference", title: "Legacy reference" },
                {
                  key: "original_date",
                  title: "Original",
                  render: (r) => dateText(r.original_date),
                },
                {
                  key: "due_date",
                  title: "Due",
                  render: (r) => dateText(r.due_date),
                },
                {
                  key: "amount",
                  title: "Imported",
                  align: "right",
                  render: (r) => currency(r.amount, meta.company.currency),
                },
                {
                  key: "outstanding",
                  title: "Remaining",
                  align: "right",
                  render: (r) =>
                    r.outstanding === null
                      ? "Unposted"
                      : r.direction === "credit"
                        ? currency(r.credit_available, meta.company.currency)
                        : currency(r.outstanding, meta.company.currency),
                },
                {
                  key: "credit",
                  title: "",
                  render: (r) =>
                    b.state === "posted" &&
                    r.direction !== "credit" &&
                    D(r.outstanding ?? 0).gt(0) &&
                    actor.permissions.includes(
                      r.kind === "customer"
                        ? "payments.receive"
                        : "payments.pay",
                    ) ? (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setCreditItem(r);
                          setCreditId("");
                          setCreditAmount("");
                          setCreditPage(1);
                          setReason("");
                          action.setError(null);
                        }}
                      >
                        Apply booked credit to {r.reference}
                      </Button>
                    ) : null,
                },
              ]}
            />
            <p className="form-note">
              Settle opening debts through the normal Customers/Suppliers
              receipt/payment allocation screen. Imported advance credits
              remain allocatable like any booked credit; unused ones convert to
              a real usable balance. Prior due dates remain in aging; imports
              do not create turnover, input/output tax, stock or tender
              movements. An allocated or credit-consumed batch cannot be
              reversed as though real settlements never happened.
            </p>
            <div className="form-actions">
              <a
                className="btn secondary"
                href={"/api/v1/print/opening-balance/" + b.id}
                target="_blank"
                rel="noreferrer"
              >
                Print opening schedule
              </a>
              {b.state === "draft" &&
                actor.permissions.includes("accounting.post") && (
                  <>
                    <Button variant="secondary" onClick={() => start(b)}>
                      Edit opening draft
                    </Button>
                    <Button onClick={() => beginReview("submitted")}>
                      Submit opening batch
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => beginReview("cancelled")}
                    >
                      Cancel unposted draft
                    </Button>
                  </>
                )}
              {b.state === "submitted" && (
                <>
                  {actor.permissions.includes("accounting.post") && (
                    <Button
                      variant="secondary"
                      onClick={() => beginReview("draft")}
                    >
                      Return opening to draft
                    </Button>
                  )}
                  {actor.permissions.includes("accounting.post") &&
                    actor.permissions.includes("accounting.close") && (
                      <Button onClick={() => beginReview("post")}>
                        Approve & post opening balances
                      </Button>
                    )}
                </>
              )}
              {b.state === "posted" &&
                actor.permissions.includes("accounting.reverse") &&
                actor.permissions.includes("accounting.close") && (
                  <Button
                    variant="secondary"
                    onClick={() => beginReview("reverse")}
                  >
                    Reverse unused opening batch
                  </Button>
                )}
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={edit}
        onClose={() => setEdit(false)}
        title={
          editId ? "Edit opening draft" : "Prepare opening AR/AP migration"
        }
        description="Positive outstanding balances only: legacy debts and party advance credits. Do not import revenue, tax, or a full invoice value already partly paid. Negative party balances import as advance credits, never as negative debt."
        wide
      >
        <form onSubmit={save}>
          {(localError || action.error) && (
            <ErrorCard error={localError || action.error} />
          )}
          <div className="form-grid">
            <FormField label="Opening branch">
              <select
                required
                value={form.branch_id ?? ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    branch_id: e.target.value,
                    accounting_date: "",
                  })
                }
              >
                {meta.branches.map((x: any) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Opening cutover date">
              <input
                type="date"
                required
                value={form.accounting_date ?? ""}
                onChange={(e) =>
                  setForm({ ...form, accounting_date: e.target.value })
                }
              />
            </FormField>
            <FormField label="Source ledger reference">
              <input
                required
                minLength={3}
                maxLength={160}
                value={form.reference ?? ""}
                onChange={(e) =>
                  setForm({ ...form, reference: e.target.value })
                }
              />
            </FormField>
            <FormField label="Opening migration notes">
              <textarea
                value={form.notes ?? ""}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </FormField>
          </div>
          {policy.error && <ErrorCard error={policy.error} />}{" "}
          {policy.data && (
            <p className="form-note">
              Fixed cutover: {policy.data.cutover ?? "not yet set"} · Earliest
              operating debt: {policy.data.first_activity ?? "none"}. Only
              explicit approval posts balances; maker/checker and gross approval
              limits apply.
            </p>
          )}
          {items.map((row, index) => (
            <div
              className="card"
              style={{ padding: 14, marginBottom: 12 }}
              key={index}
            >
              <div className="form-grid">
                <FormField label={"Opening ledger " + (index + 1)}>
                  <select
                    value={row.kind + ":" + (row.direction ?? "debt")}
                    onChange={(e) => {
                      const kind = e.target.value.split(":")[0],
                        direction = e.target.value.endsWith(":credit")
                          ? "credit"
                          : "debt";
                      setItems((old) =>
                        old.map((r, j) =>
                          j === index
                            ? { ...r, kind, direction, contact_code: "" }
                            : r,
                        ),
                      );
                    }}
                  >
                    <option value="customer:debt">Customer receivable</option>
                    <option value="customer:credit">
                      Customer advance credit
                    </option>
                    <option value="supplier:debt">Supplier payable</option>
                    <option value="supplier:credit">
                      Supplier advance credit
                    </option>
                  </select>
                </FormField>
                {(
                  [
                    {
                      key: "contact_code",
                      label: "Contact account code",
                      required: true,
                    },
                    {
                      key: "reference",
                      label: "Legacy document reference",
                      required: true,
                    },
                    {
                      key: "original_date",
                      label: "Original document date",
                      type: "date",
                    },
                    {
                      key: "due_date",
                      label: "Original due date",
                      type: "date",
                      required: true,
                    },
                    {
                      key: "amount",
                      label: "Outstanding legacy amount",
                      type: "number",
                      required: true,
                    },
                    { key: "description", label: "Legacy item note" },
                  ] as any[]
                ).map((field) => (
                  <FormField
                    key={field.key}
                    label={field.label + " " + (index + 1)}
                  >
                    <input
                      required={field.required}
                      type={field.type ?? "text"}
                      step={field.type === "number" ? "0.01" : undefined}
                      min={field.type === "number" ? "0.01" : undefined}
                      value={row[field.key] ?? ""}
                      onChange={(e) =>
                        setItems((old) =>
                          old.map((r, j) =>
                            j === index
                              ? { ...r, [field.key]: e.target.value }
                              : r,
                          ),
                        )
                      }
                    />
                  </FormField>
                ))}
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setItems((old) => old.filter((_, j) => j !== index))
                }
              >
                Remove opening row {index + 1}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            disabled={items.length >= 500}
            onClick={() => setItems((old) => [...old, blank()])}
          >
            Add legacy balance row
          </Button>
          <div className="detail-grid" style={{ marginTop: 16 }}>
            <div>
              <span>Receivables</span>
              <strong>{currency(ar, meta.company.currency)}</strong>
            </div>
            <div>
              <span>Payables</span>
              <strong>{currency(ap, meta.company.currency)}</strong>
            </div>
            <div>
              <span>Customer advance credits</span>
              <strong>{currency(ca, meta.company.currency)}</strong>
            </div>
            <div>
              <span>Supplier advance credits</span>
              <strong>{currency(sa, meta.company.currency)}</strong>
            </div>
            <div>
              <span>Gross approval value</span>
              <strong>
                {currency(ar.plus(ap).plus(ca).plus(sa), meta.company.currency)}
              </strong>
            </div>
          </div>
          <details style={{ marginTop: 18 }}>
            <summary>Paste legacy CSV (replaces draft rows)</summary>
            <p className="form-note">
              Headers:
              kind,contact_code,reference,original_date,due_date,amount,direction,description.
              Dates YYYY-MM-DD, amounts plain decimal; direction debt (default)
              or credit; at most500 rows. No creators, currency, stock or tax
              fields.
            </p>
            <FormField label="Opening CSV">
              <textarea
                rows={6}
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
              />
            </FormField>
            <Button type="button" variant="secondary" onClick={loadCsv}>
              Load CSV into draft
            </Button>
          </details>
          <div className="form-actions">
            <Button
              type="submit"
              busy={action.busy}
              disabled={!items.length || policy.loading}
            >
              Save unposted opening draft
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!review}
        onClose={() => setReview("")}
        title={
          review === "post"
            ? "Approve opening carry-forward"
            : review === "reverse"
              ? "Reverse unused opening carry-forward"
              : "Opening draft workflow"
        }
        description="Posted history is never edited. A reversal cannot undo received/paid money or reset cutover; it appends at the original effective date and requires that period open."
      >
        <form onSubmit={doReview}>
          {action.error && <ErrorCard error={action.error} />}
          <p className="warning-box">
            Validate original outstanding debt, reference uniqueness and
            prior-system reconciliation. No revenue, VAT, stock or cash should
            be created. Creator self-approval requires explicit company policy
            and a reason; the gross item sum, not the net offset, is checked
            against approval authority.
          </p>
          <FormField label="Opening workflow reason">
            <textarea
              required
              minLength={5}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </FormField>
          {(review === "post" || review === "reverse") && (
            <label className="field">
              <span>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />{" "}
                I reviewed the carry-forward and understand the fixed cutover /
                unused-only reversal policy.
              </span>
            </label>
          )}
          <div className="form-actions">
            <Button
              type="submit"
              busy={action.busy}
              disabled={
                (review === "post" || review === "reverse") && !confirmed
              }
            >
              Confirm opening {review}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!creditItem}
        onClose={() => setCreditItem(null)}
        title="Apply booked credit to opening debt"
        description="Only an already recognized credit for the same party/branch can reduce this debt. No additional payment occurs."
      >
        <form onSubmit={applyCredit}>
          {action.error && <ErrorCard error={action.error} />}{" "}
          {credits.error && <ErrorCard error={credits.error} />}
          <FormField label="Available booked credit">
            <select
              required
              value={creditId}
              onChange={(e) => setCreditId(e.target.value)}
            >
              <option value="">Choose an available credit</option>
              {credits.data?.items?.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.source_type} ·{" "}
                  {currency(c.available, meta.company.currency)} ·{" "}
                  {String(c.source_id).slice(0, 8)}
                </option>
              ))}
            </select>
          </FormField>
          <Pagination
            page={creditPage}
            total={credits.data?.total ?? 0}
            onChange={(p) => {
              setCreditPage(p);
              setCreditId("");
            }}
          />
          <FormField label="Opening credit allocation amount">
            <input
              type="number"
              min="0.01"
              step="0.01"
              required
              value={creditAmount}
              onChange={(e) => setCreditAmount(e.target.value)}
            />
          </FormField>
          <FormField label="Opening credit allocation reason">
            <textarea
              required
              minLength={5}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </FormField>
          <div className="form-actions">
            <Button type="submit" busy={action.busy} disabled={credits.loading}>
              Apply existing credit
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
