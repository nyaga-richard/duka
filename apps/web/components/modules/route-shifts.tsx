import React, { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import {
  Truck,
  FileText,
  Printer,
  Banknote,
  MapPin,
  Plus,
  Check,
  X,
  PenLine,
  Search,
} from "lucide-react";
import { calculateLine } from "@duka/shared";
import {
  api,
  useWorkspace,
  useQuery,
  usePermission,
  currency,
  dateText,
  D,
  money,
  ApiError,
} from "../lib";
import {
  PageHeading,
  Button,
  Badge,
  Dialog,
  ErrorCard,
  FormField,
  Fields,
  SearchSelect,
  LineEditor,
  DataTable,
  StatTile,
  Pagination,
  SearchBox,
} from "../ui";
import { useList } from "./common";

function invoiceTotals(lines: any[], discountPercent: string) {
  const t = lines.reduce(
    (acc, l) => {
      const c = calculateLine({
        quantity: l.quantity,
        price: l.product?.price ?? "0",
        lineDiscount: 0,
        transactionDiscount: discountPercent || "0",
        taxRate: l.product?.tax_rate ?? 0,
        inclusive: l.product?.tax_inclusive,
      });
      return {
        net: acc.net.plus(c.net),
        tax: acc.tax.plus(c.tax),
        total: acc.total.plus(c.total),
      };
    },
    { net: D(0), tax: D(0), total: D(0) },
  );
  return {
    net: t.net.toFixed(2),
    tax: t.tax.toFixed(2),
    total: t.total.toFixed(2),
  };
}

export function RouteSalesPage() {
  const { meta, actor, notify } = useWorkspace();
  const routes = useQuery<any>("/routes?limit=100");
  const [routeId, setRouteId] = useState("");
  // Deep links from the route manager page carry ?route=<id>.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("route");
    if (q && !routeId) setRouteId(q);
  }, []);
  useEffect(() => {
    if (!routeId && routes.data?.items?.length) {
      const mine = routes.data.items.find(
        (r: any) => r.salesperson_id === actor.id,
      );
      setRouteId((mine ?? routes.data.items[0]).id);
    }
  }, [routes.data, actor.id, routeId]);
  const route = routes.data?.items?.find((r: any) => r.id === routeId);
  const routeDetail = useQuery<any>(routeId ? `/routes/${routeId}` : null);
  const shifts = useQuery<any>(
    routeId ? `/route-shifts?route_id=${routeId}&limit=50` : null,
  );
  const openShiftItem = shifts.data?.items?.find(
    (s: any) => s.status === "open",
  );
  const [shiftId, setShiftId] = useState("");
  useEffect(() => {
    if (openShiftItem) setShiftId(openShiftItem.id);
    else if (shifts.data?.items?.length && !shiftId)
      setShiftId(shifts.data.items[0].id);
  }, [openShiftItem, shifts.data, shiftId]);
  const detail = useQuery<any>(shiftId ? `/route-shifts/${shiftId}` : null);
  const [tab, setTab] = useState<
    "invoices" | "ledger" | "loading" | "delivery"
  >("invoices");
  const ledger = useQuery<any>(
    routeId && tab === "ledger" ? `/routes/${routeId}/ledger` : null,
  );
  const loadingSheet = useQuery<any>(
    shiftId && tab === "loading"
      ? `/route-shifts/${shiftId}/loading-sheet`
      : null,
  );
  const deliverySheet = useQuery<any>(
    shiftId && tab === "delivery"
      ? `/route-shifts/${shiftId}/delivery-sheet`
      : null,
  );
  const [openShiftOpen, setOpenShiftOpen] = useState(false),
    [invoiceOpen, setInvoiceOpen] = useState(false),
    [closeOpen, setCloseOpen] = useState(false),
    [paying, setPaying] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<any>(null);
  const canShift = usePermission("routes.shift"),
    canManage = usePermission("routes.manage"),
    canPay = usePermission("payments.receive");
  const isOpen = openShiftItem && openShiftItem.id === detail.data?.id;

  function refresh() {
    routes.refresh();
    routeDetail.refresh();
    shifts.refresh();
    detail.refresh();
    ledger.refresh();
    loadingSheet.refresh();
    deliverySheet.refresh();
  }

  return (
    <div>
      <PageHeading
        eyebrow="SALES · VAN ROUTES"
        title="Route sales & shifts"
        description="Each route belongs to one salesperson. Sell on credit to route customers, settle accounts later, and close with a consolidated loading sheet and delivery sheet."
      >
        {canManage && (
          <Link href="/routes-manage" className="btn secondary">
            <MapPin size={16} /> Manage routes
          </Link>
        )}
      </PageHeading>
      {error && <ErrorCard error={error} />}
      {routes.data && !routes.data.items.length && (
        <section className="card form-card">
          <h3>No routes yet</h3>
          <p className="form-note">
            Create a route, assign its salesperson and till, and place customers
            on it — then open the first route shift.
          </p>
          {canManage && (
            <div className="form-actions">
              <Link href="/routes-manage" className="btn primary">
                <Plus size={16} /> Create route
              </Link>
            </div>
          )}
        </section>
      )}
      {!!routes.data?.items?.length && (
        <>
          <section className="card form-card route-bar">
            <div className="route-bar-fields">
              <FormField label="Route">
                <select
                  value={routeId}
                  onChange={(e) => setRouteId(e.target.value)}
                >
                  {routes.data.items.map((r: any) => (
                    <option key={r.id} value={r.id}>
                      {r.code} — {r.name}
                    </option>
                  ))}
                </select>
              </FormField>
              {route && (
                <>
                  <StatTile
                    label="Salesperson"
                    value={route.salesperson ?? "Unassigned"}
                  />
                  <StatTile
                    label="Customers"
                    value={String(route.customers ?? 0)}
                  />
                  <StatTile
                    label="Route outstanding"
                    value={currency(route.outstanding, meta.company.currency)}
                  />
                </>
              )}
            </div>
            <div className="form-actions">
              {canShift && route && !openShiftItem && (
                <Button onClick={() => setOpenShiftOpen(true)}>
                  <Truck size={16} /> Open route shift
                </Button>
              )}
              {canShift && openShiftItem && (
                <>
                  <Button onClick={() => setInvoiceOpen(true)}>
                    <FileText size={16} /> New credit invoice
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setCloseOpen(true)}
                  >
                    <Check size={16} /> Close shift &amp; sheets
                  </Button>
                </>
              )}
            </div>
          </section>
          {openShiftItem && (
            <p className="form-note">
              Shift open since {dateText(openShiftItem.opened_at, true)} on{" "}
              {openShiftItem.register} · {openShiftItem.salesperson} ·{" "}
              {openShiftItem.invoices} invoices ·{" "}
              {currency(openShiftItem.invoiced, meta.company.currency)}
            </p>
          )}
          {!!shifts.data?.items?.length && (
            <section className="card form-card route-shift-picker">
              <div className="route-shift-picker-inner">
                <FormField label="Viewing shift (history)">
                  <select
                    value={shiftId}
                    onChange={(e) => setShiftId(e.target.value)}
                  >
                    {shifts.data.items.map((s: any) => (
                      <option key={s.id} value={s.id}>
                        {dateText(s.opened_at, true)} · {s.salesperson} ·{" "}
                        {s.status} · {s.invoices} invoices ·{" "}
                        {currency(s.invoiced, meta.company.currency)}
                      </option>
                    ))}
                  </select>
                </FormField>
                {detail.data && (
                  <div className="route-shift-meta">
                    <Badge
                      status={
                        detail.data.status === "open"
                          ? "approved"
                          : detail.data.status === "submitted"
                            ? "partial"
                            : "paid"
                      }
                    >
                      {detail.data.status}
                    </Badge>
                    <span className="form-note">
                      opened {dateText(detail.data.opened_at, true)}
                      {detail.data.closed_at
                        ? " · closed " + dateText(detail.data.closed_at, true)
                        : ""}
                    </span>
                  </div>
                )}
              </div>
            </section>
          )}
          <div className="tab-bar">
            {(
              [
                ["invoices", "Shift invoices"],
                ["ledger", "Route ledger"],
                ["loading", "Loading sheet"],
                ["delivery", "Delivery sheet"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={`tab ${tab === key ? "active" : ""}`}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "invoices" && (
            <section className="card">
              {detail.error && <ErrorCard error={detail.error} />}
              {!detail.data?.invoices?.length && (
                <p className="form-note card-note">
                  No invoices on this shift yet
                  {isOpen
                    ? " — post the first one with “New credit invoice”."
                    : "."}
                </p>
              )}
              {!!detail.data?.invoices?.length && (
                <DataTable
                  columns={[
                    { key: "number", title: "Invoice" },
                    { key: "customer", title: "Customer" },
                    {
                      key: "created_at",
                      title: "Time",
                      render: (r: any) => dateText(r.created_at, true),
                    },
                    {
                      key: "total",
                      title: "Amount",
                      render: (r: any) =>
                        currency(r.total, meta.company.currency),
                    },
                    {
                      key: "outstanding",
                      title: "Outstanding",
                      render: (r: any) => (
                        <Badge
                          status={D(r.outstanding).gt(0) ? "partial" : "paid"}
                        >
                          {currency(r.outstanding, meta.company.currency)}
                        </Badge>
                      ),
                    },
                    {
                      key: "id",
                      title: "",
                      render: (r: any) => (
                        <a
                          className="icon-btn"
                          aria-label={"Print invoice " + r.number}
                          target="_blank"
                          href={`/api/v1/sales/${r.id}/receipt`}
                        >
                          <Printer size={16} />
                        </a>
                      ),
                    },
                  ]}
                  items={detail.data.invoices}
                />
              )}
              {!!detail.data?.invoices?.length && (
                <p className="form-note card-note">
                  {detail.data.invoices.length} sales invoices · invoiced{" "}
                  {currency(detail.data.totals.invoiced, meta.company.currency)}{" "}
                  · outstanding{" "}
                  {currency(
                    detail.data.totals.outstanding,
                    meta.company.currency,
                  )}
                </p>
              )}
            </section>
          )}
          {tab === "ledger" && (
            <section className="card">
              {ledger.error && <ErrorCard error={ledger.error} />}
              <p className="form-note card-note">
                Per-customer account position across this route. Payments posted
                later via “Collect” clear the customer's open invoices.
              </p>
              <DataTable
                columns={[
                  { key: "customer", title: "Customer" },
                  {
                    key: "closing",
                    title: "Ledger closing",
                    render: (r: any) =>
                      currency(r.closing ?? r.balance, meta.company.currency),
                  },
                  {
                    key: "balance",
                    title: "Outstanding",
                    render: (r: any) => (
                      <Badge status={D(r.balance).gt(0) ? "partial" : "paid"}>
                        {currency(r.balance, meta.company.currency)}
                      </Badge>
                    ),
                  },
                  {
                    key: "items",
                    title: "Activity",
                    render: (r: any) =>
                      `${r.items?.length ?? 0} ledger entries`,
                  },
                  {
                    key: "customer_id",
                    title: "",
                    render: (r: any) =>
                      canPay && D(r.balance).gt(0) ? (
                        <Button
                          variant="secondary"
                          onClick={() => setPaying(r)}
                        >
                          <Banknote size={15} /> Collect
                        </Button>
                      ) : null,
                  },
                ]}
                items={ledger.data?.customers ?? []}
              />
            </section>
          )}
          {tab === "loading" && (
            <section className="card">
              {loadingSheet.error && <ErrorCard error={loadingSheet.error} />}
              <div className="table-toolbar">
                <h3>Consolidated loading sheet</h3>
                {detail.data && (
                  <a
                    className="icon-btn"
                    aria-label="Print loading sheet"
                    target="_blank"
                    href={`/api/v1/print/route-loading/${detail.data.id}`}
                  >
                    <Printer size={16} />
                  </a>
                )}
              </div>
              <DataTable
                columns={[
                  { key: "name", title: "Product" },
                  { key: "sku", title: "SKU" },
                  {
                    key: "quantity",
                    title: "Quantity",
                    render: (r: any) =>
                      `${numberFmt(r.quantity)} ${r.unit ?? ""}`,
                  },
                  {
                    key: "total",
                    title: "Invoice value",
                    render: (r: any) =>
                      currency(r.total, meta.company.currency),
                  },
                ]}
                items={loadingSheet.data?.lines ?? []}
              />
              {!!loadingSheet.data && (
                <p className="form-note card-note">
                  Total goods invoiced:{" "}
                  {numberFmt(loadingSheet.data.totals.quantity)} units · value{" "}
                  {currency(
                    loadingSheet.data.totals.total,
                    meta.company.currency,
                  )}
                  — consolidated from this shift's invoices; later returns
                  adjust stock separately.
                </p>
              )}
            </section>
          )}
          {tab === "delivery" && (
            <section className="card">
              {deliverySheet.error && <ErrorCard error={deliverySheet.error} />}
              <div className="table-toolbar">
                <h3>Delivery sheet</h3>
                {detail.data && (
                  <a
                    className="icon-btn"
                    aria-label="Print delivery sheet"
                    target="_blank"
                    href={`/api/v1/print/route-delivery/${detail.data.id}`}
                  >
                    <Printer size={16} />
                  </a>
                )}
              </div>
              {(deliverySheet.data?.customers ?? []).map((c: any) => (
                <div className="delivery-customer" key={c.customer}>
                  <div className="table-toolbar">
                    <h4 className="subheading">{c.customer}</h4>
                    <span className="form-note">
                      {currency(c.total, meta.company.currency)} · outstanding{" "}
                      {currency(c.outstanding, meta.company.currency)}
                    </span>
                  </div>
                  <DataTable
                    columns={[
                      { key: "number", title: "Invoice" },
                      {
                        key: "at",
                        title: "Time",
                        render: (r: any) => dateText(r.at, true),
                      },
                      {
                        key: "total",
                        title: "Amount",
                        render: (r: any) =>
                          currency(r.total, meta.company.currency),
                      },
                      {
                        key: "outstanding",
                        title: "Balance",
                        render: (r: any) =>
                          currency(r.outstanding, meta.company.currency),
                      },
                    ]}
                    items={c.invoices}
                  />
                </div>
              ))}
              {deliverySheet.data && !deliverySheet.data.customers.length && (
                <p className="form-note card-note">
                  No deliveries on this shift.
                </p>
              )}
            </section>
          )}
        </>
      )}

      <OpenRouteShiftDialog
        open={openShiftOpen}
        route={route}
        onClose={() => setOpenShiftOpen(false)}
        onOpened={() => {
          setOpenShiftOpen(false);
          refresh();
          notify("Route shift open. Sell against route customers only.");
        }}
      />
      <InvoiceDialog
        open={invoiceOpen}
        shift={openShiftItem}
        route={route}
        onClose={() => setInvoiceOpen(false)}
        onPosted={(n: string) => {
          setInvoiceOpen(false);
          refresh();
          notify(`Sales invoice ${n} posted to the customer's account.`);
        }}
      />
      <CloseRouteShiftDialog
        open={closeOpen}
        shift={openShiftItem}
        onClose={() => setCloseOpen(false)}
        onClosed={() => {
          setCloseOpen(false);
          refresh();
          setTab("loading");
          notify("Route shift closed. Loading and delivery sheets are ready.");
        }}
      />
      {paying && (
        <RoutePaymentDialog
          customer={paying}
          branchId={detail.data?.branch_id ?? meta.branches[0]?.id}
          shiftId={openShiftItem?.id}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            refresh();
            notify("Payment posted and allocated to open invoices.");
          }}
        />
      )}
    </div>
  );
}

const numberFmt = (v: any) => {
  try {
    return D(v).toString();
  } catch {
    return String(v);
  }
};

// ---------- Route management (manage routes page) ----------

export function RouteManagePage() {
  const { meta, notify } = useWorkspace();
  const canManage = usePermission("routes.manage");
  const list = useList("/routes", { limit: 200 });
  const staff = useQuery<any>(canManage ? "/staff/picklist" : null);
  const [editing, setEditing] = useState<any>(undefined),
    [form, setForm] = useState<any>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<any>(null),
    [selected, setSelected] = useState<any>(null);
  const customers = useQuery<any>(
    selected
      ? `/customers?route_id=${selected.id}&limit=100&active=true`
      : null,
  );
  const stats = useMemo(() => {
    const items = list.data?.items ?? [];
    return items.reduce(
      (acc: any, r: any) => ({
        routes: acc.routes + 1,
        active: acc.active + (r.active ? 1 : 0),
        customers: acc.customers + Number(r.customers ?? 0),
        outstanding: acc.outstanding.plus(r.outstanding ?? "0"),
        openShifts: acc.openShifts + Number(r.open_shifts ?? 0),
      }),
      {
        routes: 0,
        active: 0,
        customers: 0,
        outstanding: D(0),
        openShifts: 0,
      },
    );
  }, [list.data]);
  const registerOptions = meta.registers.map((r: any) => ({
    id: r.id,
    name: r.name + (r.warehouse ? " · " + r.warehouse : ""),
  }));

  function edit(v?: any) {
    setError(null);
    setEditing(v ?? {});
    setForm(
      v
        ? {
            name: v.name,
            code: v.code,
            salesperson_id: v.salesperson_id ?? "",
            register_id: v.register_id ?? "",
            active: v.active,
            notes: v.notes ?? "",
          }
        : { name: "", code: "", active: true },
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: any = {
        name: form.name,
        code: form.code,
        active: !!form.active,
        // null clears the assignment; blank keeps nothing pending
        salesperson_id: form.salesperson_id || null,
        register_id: form.register_id || null,
      };
      if (form.notes) body.notes = form.notes;
      if (!editing?.id) delete body.notes_if_blank;
      await api(editing?.id ? `/routes/${editing.id}` : "/routes", {
        method: editing?.id ? "PUT" : "POST",
        body,
        key: crypto.randomUUID(),
      });
      setEditing(undefined);
      list.refresh();
      notify(
        editing?.id
          ? `Route ${body.code} updated.`
          : `Route ${body.code} created — open its first shift from Van route sales.`,
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(r: any) {
    setBusy(true);
    setError(null);
    try {
      await api(`/routes/${r.id}`, {
        method: "PUT",
        body: {
          name: r.name,
          code: r.code,
          active: !r.active,
          salesperson_id: r.salesperson_id ?? null,
          register_id: r.register_id ?? null,
          ...(r.notes ? { notes: r.notes } : {}),
        },
        key: crypto.randomUUID(),
      });
      list.refresh();
      notify(`Route ${r.code} ${r.active ? "deactivated" : "reactivated"}.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const fields = [
    { key: "name", label: "Route name", required: true },
    {
      key: "code",
      label: "Route code",
      required: true,
      help: "Short code shown on sheets and ledgers, e.g. RT-02.",
    },
    {
      key: "salesperson_id",
      label: "Assigned salesperson",
      type: "select",
      options: staff.data?.items
        .filter((u: any) => u.status === "active")
        .map((u: any) => ({ id: u.id, name: u.name })),
      help: "Only this person can open the route's shift in the van. Leave unassigned to let any route-shift holder drive it.",
    },
    {
      key: "register_id",
      label: "Route till",
      type: "select",
      options: registerOptions,
      help: "Invoices posted on a route shift deduct stock from this till's warehouse.",
    },
    { key: "active", label: "Active (accepts sales)", type: "checkbox" },
    {
      key: "notes",
      label: "Route notes (streets, drops, days)",
      type: "textarea",
      full: true,
    },
  ];

  return (
    <div>
      <PageHeading
        eyebrow="SALES · VAN ROUTES"
        title="Manage routes"
        description="Create and maintain van-sales routes: one route pairs a salesperson with a till, and every route owns its customers."
      >
        <Button onClick={() => edit()}>
          <Plus size={16} /> Create route
        </Button>
      </PageHeading>
      {!canManage && (
        <section className="card form-card">
          <h3>Manage access required</h3>
          <p className="form-note">
            Only managers with the users.manage-style routes.manage permission
            can create or edit routes. Ask an owner to grant it, or head to{" "}
            <Link href="/route-sales">Van route sales</Link>.
          </p>
        </section>
      )}
      {canManage && (
        <>
          <section className="card detail-header">
            <div className="stat-list">
              <StatTile label="Routes" value={String(stats.routes)} />
              <StatTile label="Active" value={String(stats.active)} />
              <StatTile
                label="Customers on routes"
                value={String(stats.customers)}
              />
              <StatTile
                label="Route receivables"
                value={currency(stats.outstanding, meta.company.currency)}
                tone={stats.outstanding.gt(0) ? "warn" : undefined}
              />
              <StatTile
                label="Open route shifts"
                value={String(stats.openShifts)}
              />
            </div>
          </section>
          {editing !== undefined && (
            <section className="card form-card">
              <h3>
                {editing?.id
                  ? "Edit route " + (editing.code ?? "")
                  : "Create a route"}
              </h3>
              <p className="form-note">
                Once a route exists, open its shift from the Van route sales
                page; invoices post against the route's till and customers.
              </p>
              {error && <ErrorCard error={error} />}
              <form onSubmit={save}>
                <Fields
                  fields={fields as any}
                  value={form}
                  onChange={setForm}
                />
                <div className="form-actions">
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => setEditing(undefined)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" busy={busy}>
                    <Check size={16} />{" "}
                    {editing?.id ? "Save route" : "Create route"}
                  </Button>
                </div>
              </form>
            </section>
          )}
          {error && editing === undefined && <ErrorCard error={error} />}
          <section className="card">
            <div className="table-toolbar">
              <SearchBox
                value={list.search}
                onChange={list.setSearch}
                placeholder="Search route name or code…"
              />
              <span className="muted">{list.data?.total ?? 0} routes</span>
            </div>
            {list.error && <ErrorCard error={list.error} />}
            <DataTable
              items={list.data?.items}
              loading={list.loading}
              onRow={(r: any) => setSelected(r)}
              columns={[
                { key: "code", title: "Code" },
                { key: "name", title: "Route" },
                {
                  key: "salesperson",
                  title: "Salesperson",
                  render: (r: any) => r.salesperson ?? "Unassigned",
                },
                {
                  key: "register",
                  title: "Till",
                  render: (r: any) => r.register ?? "—",
                },
                { key: "customers", title: "Customers" },
                {
                  key: "outstanding",
                  title: "Receivables",
                  render: (r: any) =>
                    currency(r.outstanding, meta.company.currency),
                },
                {
                  key: "open_shifts",
                  title: "Shift",
                  render: (r: any) => (
                    <Badge status={r.open_shifts > 0 ? "approved" : "draft"}>
                      {r.open_shifts > 0 ? "Open" : "Closed"}
                    </Badge>
                  ),
                },
                {
                  key: "active",
                  title: "Status",
                  render: (r: any) => (
                    <Badge status={r.active ? "paid" : "void"}>
                      {r.active ? "Active" : "Inactive"}
                    </Badge>
                  ),
                },
                {
                  key: "id",
                  title: "",
                  render: (r: any) => (
                    <span className="row-actions">
                      <Link
                        className="icon-btn"
                        href={`/route-sales?route=${r.id}`}
                        aria-label={"Open route sales for " + r.code}
                        title="Open route sales"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Truck size={15} />
                      </Link>
                      <Button
                        variant="secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(r);
                        }}
                      >
                        Customers
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          edit(r);
                        }}
                      >
                        <PenLine size={14} /> Edit
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(r);
                        }}
                      >
                        {r.active ? "Deactivate" : "Reactivate"}
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
            <Pagination
              page={list.page}
              total={list.data?.total ?? 0}
              limit={200}
              onChange={list.setPage}
            />
          </section>
          {selected && (
            <section className="card">
              <div className="table-toolbar">
                <h3 className="subheading">
                  Customers on {selected.code} — {selected.name}
                </h3>
                <Button variant="secondary" onClick={() => setSelected(null)}>
                  <X size={15} /> Close
                </Button>
              </div>
              {customers.error && <ErrorCard error={customers.error} />}
              <DataTable
                items={customers.data?.items}
                loading={customers.loading}
                columns={[
                  { key: "name", title: "Customer" },
                  { key: "code", title: "Code" },
                  {
                    key: "phone",
                    title: "Phone",
                    render: (r: any) => r.phone ?? "—",
                  },
                  {
                    key: "credit_limit",
                    title: "Credit limit",
                    render: (r: any) =>
                      currency(r.credit_limit, meta.company.currency),
                  },
                  {
                    key: "balance",
                    title: "Balance",
                    render: (r: any) => (
                      <Badge status={D(r.balance).gt(0) ? "partial" : "paid"}>
                        {currency(r.balance, meta.company.currency)}
                      </Badge>
                    ),
                  },
                ]}
              />
              <p className="form-note card-note">
                Assign or move customers from the Customers page — each customer
                belongs to one route.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function OpenRouteShiftDialog({
  open,
  route,
  onClose,
  onOpened,
}: {
  open: boolean;
  route: any;
  onClose: () => void;
  onOpened: () => void;
}) {
  const { meta } = useWorkspace();
  const [float, setFloat] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  useEffect(() => {
    if (open) {
      setFloat("0");
      setError(null);
    }
  }, [open]);
  async function openShift(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/route-shifts/open", {
        method: "POST",
        body: { route_id: route.id, opening_float: money(float || 0) },
        key: crypto.randomUUID(),
      });
      onOpened();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Open route shift — ${route?.name ?? ""}`}
      description="The route's till is locked by this shift until close. Only customers assigned to the route can be invoiced."
    >
      <form onSubmit={openShift}>
        {error && <ErrorCard error={error} />}
        <FormField label="Cash float held by the salesperson">
          <input
            inputMode="decimal"
            value={float}
            onChange={(e) => setFloat(e.target.value)}
            autoFocus
          />
        </FormField>
        <div className="form-actions">
          <Button type="submit" busy={busy}>
            <Truck size={16} /> Open shift
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function InvoiceDialog({
  open,
  shift,
  route,
  onClose,
  onPosted,
}: {
  open: boolean;
  shift: any;
  route: any;
  onClose: () => void;
  onPosted: (n: string) => void;
}) {
  const { meta } = useWorkspace();
  const [customer, setCustomer] = useState<any>(null);
  const [lines, setLines] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  useEffect(() => {
    if (open) {
      setCustomer(null);
      setLines([]);
      setError(null);
    }
  }, [open]);
  const totals = useMemo(() => {
    try {
      return invoiceTotals(
        lines.filter((l) => l.product_id),
        "0",
      );
    } catch {
      return { net: "0.00", tax: "0.00", total: "0.00" };
    }
  }, [lines]);
  const balanceNotice = (() => {
    const limit = D(customer?.credit_limit ?? 0);
    const balance = D(customer?.balance ?? 0);
    const room = limit.minus(balance);
    return {
      room,
      blocked: limit.gt(0) && room.lt(totals.total || "0"),
    };
  })();
  async function post(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!customer) throw new Error("Choose a route customer first.");
      if (!lines.length) throw new Error("Add at least one line.");
      const body = {
        register_id: shift.register_id,
        customer_id: customer.id,
        lines: lines.map((l) => ({
          product_id: l.product_id,
          quantity: l.quantity,
          serials: [],
        })),
        discount_percent: "0",
        payments: [],
        customer_credit: "0",
      };
      const result: any = await api("/sales", {
        method: "POST",
        body,
        key: crypto.randomUUID(),
      });
      onPosted(result.number);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New route sales invoice"
      description={`Credit invoice on ${route?.name ?? "route"} · ${route?.register ?? "route till"} — no payment is collected now.`}
      wide
    >
      <form onSubmit={post}>
        {error && <ErrorCard error={error} />}
        <SearchSelect
          endpoint={`/customers?route_id=${route?.id}&active=true`}
          label="Route customer"
          value={customer}
          onChange={setCustomer}
          placeholder="Search customers assigned to this route…"
        />
        {customer && (
          <p className="form-note">
            Credit limit{" "}
            {currency(customer.credit_limit, meta.company.currency)} · balance{" "}
            {currency(customer.balance ?? 0, meta.company.currency)} · room{" "}
            {currency(balanceNotice.room, meta.company.currency)} · invoices due
            in {customer.credit_days ?? 30} days.
          </p>
        )}
        <LineEditor lines={lines} onChange={setLines} />
        <div className="cart-grand-total">
          <span>Invoice total (on account)</span>
          <strong>{currency(totals.total, meta.company.currency)}</strong>
        </div>
        {balanceNotice.blocked && (
          <p className="form-note">
            This exceeds the customer's credit limit floor. A manager's override
            reason is required — post it from the POS with an authorized reason.
          </p>
        )}
        <div className="form-actions">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            busy={busy}
            disabled={!customer || !lines.length || busy}
          >
            <FileText size={16} /> Post sales invoice
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CloseRouteShiftDialog({
  open,
  shift,
  onClose,
  onClosed,
}: {
  open: boolean;
  shift: any;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { meta } = useWorkspace();
  const cash = meta.payment_methods.find((m: any) => m.kind === "cash");
  const [cashCount, setCashCount] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  useEffect(() => {
    if (open) {
      setCashCount("0");
      setError(null);
    }
  }, [open]);
  async function close(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/route-shifts/${shift.id}/close`, {
        method: "POST",
        body: { counts: cash ? { [cash.id]: money(cashCount || 0) } : {} },
        key: crypto.randomUUID(),
      });
      onClosed();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Close route shift"
      description="Counts the till cash and freezes the shift. The consolidated loading sheet and the delivery sheet stay printable afterward."
    >
      <form onSubmit={close}>
        {error && <ErrorCard error={error} />}
        {cash && (
          <FormField label="Physical cash counted">
            <input
              inputMode="decimal"
              value={cashCount}
              onChange={(e) => setCashCount(e.target.value)}
              autoFocus
            />
          </FormField>
        )}
        <p className="form-note">
          Credit balances stay on customer accounts and are settled via the
          route ledger's Collect action.
        </p>
        <div className="form-actions">
          <Button variant="secondary" type="button" onClick={onClose}>
            Keep open
          </Button>
          <Button type="submit" busy={busy}>
            <Check size={16} /> Close shift
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RoutePaymentDialog({
  customer,
  branchId,
  shiftId,
  onClose,
  onDone,
}: {
  customer: any;
  branchId: string;
  shiftId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { meta } = useWorkspace();
  const openItems = useQuery<any>(
    customer ? `/customers/${customer.customer_id}/open-items` : null,
  );
  const [amount, setAmount] = useState(""),
    [methodId, setMethodId] = useState(""),
    [reference, setReference] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<any>(null);
  useEffect(() => {
    setAmount(money(customer.balance));
    setMethodId(
      meta.payment_methods.find((m: any) => m.kind === "cash")?.id ??
        meta.payment_methods[0]?.id,
    );
  }, [customer, meta]);
  // FIFO-allocate the paid amount across the customer's open invoices.
  const allocations = useMemo(() => {
    const items = [...(openItems.data?.items ?? [])];
    let left = (() => {
      try {
        return V(amount);
      } catch {
        return D(0);
      }
    })();
    const out: {
      document_id: string;
      document_type: string;
      amount: string;
    }[] = [];
    for (const i of items) {
      if (left.lte(0)) break;
      const due = D(i.outstanding ?? i.balance ?? "0");
      if (due.lte(0)) continue;
      const a = left.gte(due) ? due : left;
      out.push({
        document_id: i.id ?? i.document_id,
        document_type: i.kind === "opening" ? "opening" : "invoice",
        amount: money(a),
      });
      left = left.minus(a);
    }
    return out;
  }, [openItems.data, amount]);
  async function pay(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!allocations.length)
        throw new ApiError(
          "VALIDATION_ERROR",
          "Nothing outstanding to allocate against.",
        );
      await api("/customers/settlements", {
        method: "POST",
        body: {
          contact_id: customer.customer_id,
          branch_id: branchId,
          payment: {
            method_id: methodId,
            amount: money(amount),
            ...(reference ? { reference } : {}),
          },
          ...(shiftId ? { shift_id: shiftId } : {}),
          allocations,
        },
        key: crypto.randomUUID(),
      });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const allocated = allocations.reduce((n, a) => n.plus(a.amount), D(0));
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Collect from ${customer.customer}`}
      description={`Clear this route customer's account. Outstanding: ${currency(customer.balance, meta.company.currency)}.`}
    >
      <form onSubmit={pay}>
        {error && <ErrorCard error={error} />}
        {openItems.error && <ErrorCard error={openItems.error} />}
        <FormField label="Amount received">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
        </FormField>
        <FormField label="Payment method">
          <select
            value={methodId}
            onChange={(e) => setMethodId(e.target.value)}
          >
            {meta.payment_methods.map((m: any) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Reference (optional)">
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </FormField>
        <p className="form-note">
          Allocates oldest-first across {allocations.length} open invoices ·{" "}
          {currency(allocated, meta.company.currency)} applied
          {D(amount || 0)
            .minus(allocated)
            .gt(0)
            ? ` · ${currency(D(amount || 0).minus(allocated), meta.company.currency)} held as account credit`
            : ""}
          .
        </p>
        <div className="form-actions">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={busy}>
            <Banknote size={16} /> Post payment & clear
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// Kept local: decimal draft parse identical to POS' V()
function V(v: any) {
  return D(v ?? 0);
}
