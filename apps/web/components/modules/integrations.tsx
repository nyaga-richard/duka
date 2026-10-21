"use client";
import React, { useState, useEffect } from "react";
import {
  Plus,
  Smartphone,
  ShieldCheck,
  RefreshCw,
  Plug,
  AlertTriangle,
  ArrowUpRight,
  Check,
  WifiOff,
  Download,
  Upload,
  CloudCheck,
  LockKeyhole,
  Monitor,
  ArrowRight,
} from "lucide-react";
import {
  api,
  useWorkspace,
  currency,
  dateText,
  useQuery,
  privateStore,
  updatePrivateStore,
  D,
  download,
} from "../lib";
import {
  Button,
  Badge,
  PageHeading,
  DataTable,
  Pagination,
  Dialog,
  ErrorCard,
  Fields,
  FormField,
  SearchSelect,
} from "../ui";
import { useList, useAction } from "./common";
export function IntegrationsPage() {
  const { meta } = useWorkspace();
  const status = useQuery<any>("/integrations/status");
  const config = useQuery<any>("/integrations/config");
  const [setupProvider, setSetupProvider] = useState<
    "mpesa" | "etims" | null
  >(null);
  const [setupValues, setSetupValues] = useState<any>({});
  const [setupEnable, setSetupEnable] = useState(false);
  const [tab, setTab] = useState("mpesa"),
    [refund, setRefund] = useState<any>(null),
    [form, setForm] = useState<any>({});
  const list = useList(
    tab === "mpesa"
      ? "/integrations/mpesa"
      : tab === "fiscal"
        ? "/integrations/fiscal"
        : "/payments/refunds",
  );
  const action = useAction(() => {
    setRefund(null);
    list.refresh();
  });
  return (
    <>
      <PageHeading
        eyebrow="CONNECTED SERVICES"
        title="Integrations"
        description="Explicit confirmation. Visible failures. No invented payment or fiscal success."
      >
        <Button
          variant="secondary"
          onClick={() => {
            list.refresh();
            status.refresh();
          }}
        >
          <RefreshCw size={16} /> Refresh status
        </Button>
      </PageHeading>
      <div className="integration-grid">
        <section className="card integration-card">
          <div className="integration-logo mpesa">
            <Smartphone size={26} />
          </div>
          <div>
            <h2>M-Pesa / Daraja</h2>
            <p>
              STK initiation → token-bound callback → independent provider query
              → allocation.
            </p>
            <Badge
              status={
                status.data?.mpesa_mode === "daraja" ? "pending" : "neutral"
              }
            >
              {status.data?.mpesa_mode ?? "Loading"}
            </Badge>
          </div>
          <small>
            {status.data?.mpesa_credentials_configured
              ? "Credentials configured; merchant and production acceptance testing still required."
              : config.data?.mpesa?.configured
                ? "Credentials are saved for this business; live merchant acceptance testing remains yours."
                : "No live merchant credentials yet. Set up below with your Daraja values, or keep the deployment default. Results from the test provider are not real money."}
          </small>
        </section>
        <section className="card integration-card">
          <div className="integration-logo fiscal">
            <ShieldCheck size={26} />
          </div>
          <div>
            <h2>KRA eTIMS boundary</h2>
            <p>
              Certified gateway adapter with idempotency, identifiers, retries
              and failure visibility.
            </p>
            <Badge
              status={
                status.data?.fiscal_mode === "adapter" ? "pending" : "neutral"
              }
            >
              {status.data?.fiscal_mode ?? "Loading"}
            </Badge>
          </div>
          <small>
            No direct KRA certification is claimed. OSCU/VSCU onboarding and
            current schema acceptance must be completed externally.
          </small>
        </section>
      </div>
      {config.error && <ErrorCard error={config.error} />}
      {!config.error && (
      <div className="integration-config-bar">
        {(["mpesa", "etims"] as const).map((pv) => {
          const c = config.data?.[pv];
          return (
            <div className="card integration-config" key={pv}>
              <div className="integration-config-text">
                <h3>
                  {pv === "mpesa" ? "M-Pesa credentials" : "eTIMS gateway"}
                </h3>
                <p>
                  {config.loading && !config.data
                    ? "Loading configuration…"
                    : c?.configured
                      ? `Configured by ${c.updated_by} · values are never shown back.`
                      : "Not configured yet; the deployment environment stays the default."}
                </p>
              </div>
              <div className="integration-config-side">
                <Badge status={c?.enabled ? "active" : "neutral"}>
                  {c?.configured
                    ? c.enabled
                      ? "Enabled"
                      : "Disabled"
                    : "Not configured"}
                </Badge>
                <div className="form-actions compact">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSetupProvider(pv);
                      setSetupValues({});
                      setSetupEnable(!!c?.enabled);
                      action.setError(null);
                    }}
                  >
                    {c?.configured ? "Reconfigure" : "Set up"}
                  </Button>
                  {c?.configured && (
                    <Button
                      variant={c.enabled ? "secondary" : "primary"}
                      busy={action.busy}
                      onClick={() =>
                        action.run(
                          () =>
                            api("/integrations/config", {
                              method: "PUT",
                              body: { provider: pv, enabled: !c.enabled },
                            }).then((r) => {
                              config.refresh();
                              status.refresh();
                              return r;
                            }),
                          c.enabled
                            ? "Integration disabled."
                            : "Integration enabled.",
                        )
                      }
                    >
                      {c.enabled ? "Disable" : "Enable"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      )}
      <div className="warning-box">
        <AlertTriangle size={20} />
        <p>
          Daraja callbacks are not treated as signed payment evidence.
          Successful settlement requires a server-to-provider query bound to the
          stored request and matching callback metadata. External refunds stay
          liabilities until a manager independently reconciles settlement.
          Normal PDF receipts are not fiscal invoices.
        </p>
      </div>
      <div className="page-tabs">
        <button
          className={tab === "mpesa" ? "active" : ""}
          onClick={() => setTab("mpesa")}
        >
          Mobile-money intents
        </button>
        <button
          className={tab === "fiscal" ? "active" : ""}
          onClick={() => setTab("fiscal")}
        >
          Fiscal submissions
        </button>
        <button
          className={tab === "refunds" ? "active" : ""}
          onClick={() => setTab("refunds")}
        >
          External refunds
        </button>
      </div>
      <section className="card">
        {list.error && <ErrorCard error={list.error} />}{" "}
        {action.error && !refund && <ErrorCard error={action.error} />}
        <DataTable
          loading={list.loading}
          items={list.data?.items}
          columns={
            tab === "mpesa"
              ? [
                  {
                    key: "created_at",
                    title: "Initiated",
                    render: (r) => dateText(r.created_at, true),
                  },
                  { key: "provider", title: "Provider" },
                  {
                    key: "amount",
                    title: "Amount",
                    align: "right",
                    render: (r) => currency(r.amount, meta.company.currency),
                  },
                  {
                    key: "status",
                    title: "State",
                    render: (r) => <Badge status={r.status}>{r.status}</Badge>,
                  },
                  { key: "receipt_number", title: "Confirmed receipt" },
                  { key: "last_error", title: "Diagnostic" },
                ]
              : tab === "fiscal"
                ? [
                    { key: "document_number", title: "Document" },
                    { key: "source_type", title: "Type" },
                    {
                      key: "status",
                      title: "Fiscal state",
                      render: (r) => (
                        <Badge status={r.status}>{r.status}</Badge>
                      ),
                    },
                    { key: "fiscal_id", title: "Provider identifier" },
                    { key: "attempts", title: "Attempts" },
                    { key: "error", title: "Last error" },
                    {
                      key: "retry",
                      title: "",
                      render: (r) =>
                        r.status !== "successful" ? (
                          <Button
                            variant="ghost"
                            busy={action.busy}
                            onClick={() =>
                              action.run(
                                () =>
                                  api(
                                    "/integrations/fiscal/" + r.id + "/retry",
                                    { method: "POST", body: {} },
                                  ),
                                "Fiscal retry queued; not yet successful.",
                              )
                            }
                          >
                            <RefreshCw size={14} /> Retry
                          </Button>
                        ) : null,
                    },
                  ]
                : [
                    { key: "credit_note", title: "Credit note" },
                    { key: "method", title: "Refund method" },
                    {
                      key: "amount",
                      title: "Amount",
                      align: "right",
                      render: (r) => currency(r.amount, meta.company.currency),
                    },
                    {
                      key: "status",
                      title: "Settlement",
                      render: (r) => (
                        <Badge status={r.status}>{r.status}</Badge>
                      ),
                    },
                    {
                      key: "provider_reference",
                      title: "Reconciled reference",
                    },
                    {
                      key: "action",
                      title: "",
                      render: (r) =>
                        r.status !== "settled" ? (
                          <Button
                            variant="secondary"
                            onClick={() => {
                              setRefund(r);
                              setForm({ provider_reference: "", reason: "" });
                              action.setError(null);
                            }}
                          >
                            Record reconciled settlement
                          </Button>
                        ) : null,
                    },
                  ]
          }
        />
        <Pagination
          page={list.page}
          total={list.data?.total ?? 0}
          onChange={list.setPage}
        />
      </section>
      <div className="integration-links">
        <a
          href="https://developer.safaricom.co.ke/"
          target="_blank"
          rel="noreferrer"
        >
          Safaricom Daraja onboarding <ArrowUpRight size={15} />
        </a>
        <a
          href="https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/etims-system-to-system-integration"
          target="_blank"
          rel="noreferrer"
        >
          KRA integration & certification <ArrowUpRight size={15} />
        </a>
        <a href="/api/v1/docs" target="_blank" rel="noreferrer">
          API documentation <ArrowUpRight size={15} />
        </a>
      </div>
      <Dialog
        open={!!refund}
        onClose={() => setRefund(null)}
        title="Confirm externally reconciled refund"
        description="Use this only after independently matching the actual provider/bank settlement. This action posts the payment and clears the refund liability."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.run(
              () =>
                api("/payments/refunds/" + refund.id + "/confirm", {
                  method: "POST",
                  body: form,
                }),
              "External refund settlement posted.",
            );
          }}
        >
          {action.error && <ErrorCard error={action.error} />}
          <Fields
            fields={[
              {
                key: "provider_reference",
                label: "Confirmed provider / bank reference",
                required: true,
              },
              {
                key: "reason",
                label: "Reconciliation evidence / reason",
                type: "textarea",
                required: true,
                full: true,
              },
            ]}
            value={form}
            onChange={setForm}
          />
          <div className="form-actions">
            <Button type="submit" busy={action.busy}>
              Confirm settlement <Check size={16} />
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!setupProvider}
        onClose={() => setSetupProvider(null)}
        title={
          setupProvider === "mpesa"
            ? "Configure M-Pesa / Daraja"
            : "Configure KRA eTIMS gateway"
        }
        description="Credentials encrypt at rest and are never shown back. Leave every field blank to toggle enablement only."
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const pv = setupProvider as "mpesa" | "etims";
            const body: any = {
              provider: pv,
              enabled: setupEnable,
            };
            const draft: any = {};
            for (const [k, v] of Object.entries(setupValues)) {
              const sv = String(v ?? "").trim();
              if (sv) draft[k] = sv;
            }
            if (Object.keys(draft).length) body.config = draft;
            const already = config.data?.[pv]?.configured;
            if (
              Object.keys(draft).length &&
              !already &&
              ((pv === "mpesa" &&
                ![
                  "consumer_key",
                  "consumer_secret",
                  "shortcode",
                  "passkey",
                  "callback_secret",
                ].every((k) => draft[k])) ||
                (pv === "etims" &&
                  !["adapter_url", "adapter_token"].every((k) => draft[k])))
            ) {
              action.setError({
                message:
                  "A first-time configuration needs every required field; leave all blank to keep the deployment default.",
              });
              return;
            }
            if (Object.keys(draft).length && already) {
              const required =
                pv === "mpesa"
                  ? [
                      "consumer_key",
                      "consumer_secret",
                      "shortcode",
                      "passkey",
                      "callback_secret",
                    ]
                  : ["adapter_url", "adapter_token"];
              if (!required.every((k) => draft[k])) {
                action.setError({
                  message:
                    "Re-enter the complete credential set to rotate; values are stored write-only and cannot be merged.",
                });
                return;
              }
            }
            await action.run(
              () =>
                api("/integrations/config", {
                  method: "PUT",
                  body,
                }).then((r) => {
                  config.refresh();
                  status.refresh();
                  setSetupProvider(null);
                  return r;
                }),
              "Integration settings saved.",
            );
          }}
        >
          {action.error && <ErrorCard error={action.error} />}
          <Fields
            fields={
              (setupProvider === "mpesa"
                ? [
                    { key: "consumer_key", label: "Consumer key", required: true },
                    {
                      key: "consumer_secret",
                      label: "Consumer secret",
                      type: "password",
                      required: true,
                    },
                    { key: "shortcode", label: "Shortcode", required: true },
                    {
                      key: "passkey",
                      label: "Passkey (Lipa Na M-Pesa)",
                      type: "password",
                      required: true,
                    },
                    {
                      key: "callback_secret",
                      label: "Callback secret (32+ characters)",
                      type: "password",
                      required: true,
                    },
                    {
                      key: "transaction_type",
                      label: "Transaction type",
                      type: "select",
                      options: [
                        {
                          id: "CustomerPayBillOnline",
                          name: "Pay Bill (CustomerPayBillOnline)",
                        },
                        {
                          id: "CustomerBuyGoodsOnline",
                          name: "Buy Goods (CustomerBuyGoodsOnline)",
                        },
                      ],
                    },
                    {
                      key: "base_url",
                      label: "Base URL (production: https://api.safaricom.co.ke)",
                    },
                  ]
                : [
                    {
                      key: "adapter_url",
                      label: "Certified gateway URL (https)",
                      required: true,
                    },
                    {
                      key: "adapter_token",
                      label: "Gateway bearer token",
                      type: "password",
                      required: true,
                    },
                  ]) as any
            }
            value={setupValues}
            onChange={setSetupValues}
          />
          <label className="check-field">
            <input
              type="checkbox"
              checked={setupEnable}
              onChange={(e) => setSetupEnable(e.target.checked)}
            />
            <span>Enable for this business (overrides the deployment default)</span>
          </label>
          <div className="form-actions">
            <Button type="submit" busy={action.busy}>
              Save configuration <Check size={16} />
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function OfflinePage() {
  const { meta, actor, online, notify } = useWorkspace();
  const devices = useQuery<any>("/offline/devices");
  const syncRecords = useQuery<any>("/offline/sync?limit=100");
  const [active, setActive] = useState<any>(null),
    [queue, setQueue] = useState<any[]>([]),
    [deviceId, setDeviceId] = useState(""),
    [open, setOpen] = useState(false),
    [form, setForm] = useState<any>({}),
    [cacheCount, setCacheCount] = useState(0);
  const action = useAction(() => {
    setOpen(false);
    devices.refresh();
  });
  const cacheAction = useAction();
  const syncAction = useAction(() => syncRecords.refresh());
  async function load() {
    const a = await privateStore<any>("device:" + actor.id),
      q = await privateStore<any[]>("queue:" + actor.id),
      c = await privateStore<any[]>("catalog:" + actor.id);
    setActive(a);
    setDeviceId(a?.device.id ?? "");
    setQueue(q ?? []);
    setCacheCount(c?.length ?? 0);
  }
  useEffect(() => {
    load();
  }, [actor.id]);
  async function cache() {
    await cacheAction.run(async () => {
      const device = devices.data?.items.find(
        (d: any) => d.id === deviceId && d.active,
      );
      if (!device)
        throw new Error("Select an active server-authorized device first.");
      const register = meta.registers.find(
        (r: any) => r.id === device.register_id,
      );
      const records: any[] = [];
      for (let page = 1; page <= 10; page++) {
        const r: any = await api(
          "/products?warehouse_id=" +
            register.warehouse_id +
            "&limit=100&page=" +
            page,
        );
        records.push(...r.items);
        if (records.length >= r.total) break;
        if (page === 10)
          throw new Error(
            "This device supports at most 1,000 cached products. Narrow the deployed catalog before enabling offline capture.",
          );
      }
      const v: any = await api("/offline/catalog-version");
      const config = {
        device,
        version: v.version,
        cached_at: new Date().toISOString(),
      };
      await privateStore("catalog:" + actor.id, records);
      await privateStore("device:" + actor.id, config);
      await load();
      return config;
    }, "Authorized catalog cached on this device. Offline capture is cash-only and remains unposted.");
  }
  async function synchronize(row: any, accept = false) {
    await syncAction.run(async () => {
      const {
        client_id,
        device_id,
        catalog_version,
        captured_at,
        captured_shift_id,
        sale,
      } = row;
      const result: any = await api("/offline/sync", {
        method: "POST",
        body: {
          client_id,
          device_id,
          catalog_version,
          captured_at,
          captured_shift_id,
          sale,
          accept_changes: accept,
        },
      });
      const updated = await updatePrivateStore<any[]>(
        "queue:" + actor.id,
        (old) =>
          (old ?? []).map((q) =>
            q.client_id === row.client_id
              ? {
                  ...q,
                  status: result.status,
                  error: result.error,
                  sale_id: result.sale_id,
                }
              : q,
          ),
      );
      setQueue(updated);
      if (result.status === "conflict")
        notify(
          "Synchronization conflict. No sale, stock or journal was posted. Review before retrying.",
          "error",
        );
      else notify("Local capture is now confirmed and posted.");
      return result;
    }, "");
  }
  return (
    <>
      <PageHeading
        eyebrow="RESILIENCE WITHOUT FALSE PROMISES"
        title="Offline & synchronization"
        description="Local carts are drafts. Server-confirmed stock, payments and books remain authoritative."
      >
        {actor.permissions.includes("sales.price_override") && (
          <Button
            onClick={() => {
              setForm({
                user_id: actor.id,
                register_id: meta.registers[0]?.id,
                label: "",
                max_sale_amount: "20000",
              });
              action.setError(null);
              setOpen(true);
            }}
          >
            <Plus size={17} /> Authorize this device
          </Button>
        )}
      </PageHeading>
      <div className="warning-box">
        <WifiOff size={22} />
        <p>
          Offline capture works in an already-open, explicitly authorized POS
          tab. Cold offline sessions cannot sign in. Only standard-price walk-in
          cash is allowed. There is no offline M-Pesa confirmation, credit
          approval, stock guarantee, accounting posting or fiscal invoice.
          Captures expire for automatic synchronization after 24 hours.
        </p>
      </div>
      <div className="offline-grid">
        <section className="card settings-card">
          <div className="card-heading">
            <div>
              <h2>Device authorization & local catalog</h2>
              <p>
                Private cached data is cleared on sign-out. Do not enable on
                shared or untrusted devices.
              </p>
            </div>
            <Monitor size={24} />
          </div>
          {cacheAction.error && <ErrorCard error={cacheAction.error} />}
          <FormField label="Authorized device">
            <select
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
            >
              <option value="">Select authorization</option>
              {devices.data?.items
                ?.filter((d: any) => d.active)
                .map((d: any) => (
                  <option key={d.id} value={d.id}>
                    {d.label} · limit{" "}
                    {currency(d.max_sale_amount, meta.company.currency)}
                  </option>
                ))}
            </select>
          </FormField>
          <div className="detail-grid">
            <div>
              <span>Cached products</span>
              <strong>{cacheCount}</strong>
            </div>
            <div>
              <span>Last catalog refresh</span>
              <strong>
                {active ? dateText(active.cached_at, true) : "Not cached"}
              </strong>
            </div>
          </div>
          <Button
            variant="secondary"
            busy={cacheAction.busy}
            disabled={!online || !deviceId}
            onClick={cache}
          >
            <Download size={16} /> Cache authorized catalog
          </Button>
        </section>
        <section className="card settings-card">
          <div className="card-heading">
            <div>
              <h2>Safe operating rules</h2>
              <p>Synchronization never silently overwrites the ledger.</p>
            </div>
            <LockKeyhole size={23} />
          </div>
          <ul className="policy-list">
            <li>Every capture has a unique client-generated ID.</li>
            <li>
              Current server prices, tax rules, stock and permissions are
              checked again.
            </li>
            <li>Price or tax changes produce a visible conflict.</li>
            <li>Stock conflicts are not converted into negative stock.</li>
            <li>
              Never take a second payment just because a network response is
              missing.
            </li>
          </ul>
        </section>
      </div>
      <section className="card master-card">
        <div className="card-heading">
          <div>
            <h2>Locally captured sales</h2>
            <p>
              Unconfirmed until the server reports “posted”. Conflicts require
              review; re-entry must reconcile the original cash.
            </p>
          </div>
          <Button variant="ghost" onClick={load}>
            <RefreshCw size={16} /> Refresh local queue
          </Button>
        </div>
        {syncAction.error && <ErrorCard error={syncAction.error} />}
        <DataTable
          items={queue}
          columns={[
            {
              key: "client_id",
              title: "Client ID",
              render: (r) => <code>{r.client_id.slice(0, 8)}</code>,
            },
            {
              key: "captured_at",
              title: "Captured locally",
              render: (r) => dateText(r.captured_at, true),
            },
            { key: "sale", title: "Lines", render: (r) => r.sale.lines.length },
            {
              key: "status",
              title: "State",
              render: (r) => (
                <Badge status={r.status}>
                  {r.status === "local" ? "Local · unconfirmed" : r.status}
                </Badge>
              ),
            },
            {
              key: "error",
              title: "Conflict",
              render: (r) => r.error?.message ?? "—",
            },
            {
              key: "actions",
              title: "",
              render: (r) =>
                r.status !== "posted" ? (
                  <div className="table-actions">
                    <Button
                      variant="secondary"
                      busy={syncAction.busy}
                      disabled={!online}
                      onClick={() => synchronize(r)}
                    >
                      Synchronize
                    </Button>
                    {r.error?.code === "OFFLINE_CATALOG_CHANGED" && (
                      <Button
                        variant="ghost"
                        disabled={!online}
                        onClick={() => {
                          if (
                            window.confirm(
                              "Accept current server catalog rules? The original cash amount must still balance. No extra payment will be assumed.",
                            )
                          )
                            synchronize(r, true);
                        }}
                      >
                        Accept current catalog
                      </Button>
                    )}
                  </div>
                ) : (
                  <a className="text-link" href={"/sales?open=" + r.sale_id}>
                    View confirmed sale <ArrowRight size={15} />
                  </a>
                ),
            },
          ]}
        />
      </section>
      <section className="card master-card">
        <div className="card-heading">
          <div>
            <h2>Server synchronization history</h2>
            <p>Idempotent posting and persisted conflicts for this operator.</p>
          </div>
        </div>
        <DataTable
          items={syncRecords.data?.items}
          loading={syncRecords.loading}
          columns={[
            {
              key: "client_id",
              title: "Client ID",
              render: (r) => <code>{r.client_id.slice(0, 8)}</code>,
            },
            {
              key: "created_at",
              title: "Received",
              render: (r) => dateText(r.created_at, true),
            },
            {
              key: "status",
              title: "State",
              render: (r) => <Badge status={r.status}>{r.status}</Badge>,
            },
            {
              key: "error",
              title: "Diagnostic",
              render: (r) => r.error?.message ?? "Posted atomically",
            },
          ]}
        />
      </section>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Authorize a cash-capture device"
        description="This grants only local capture; all sales must still pass server checks on synchronization."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.run(
              () => api("/offline/devices", { method: "POST", body: form }),
              "Device authorization created. Cache the catalog before disconnecting.",
            );
          }}
        >
          {action.error && <ErrorCard error={action.error} />}
          {actor.permissions.includes("users.manage") && (
            <SearchSelect
              endpoint="/users"
              label="Device operator (current operator when blank)"
              onChange={(user) =>
                setForm({ ...form, user_id: user?.id ?? actor.id })
              }
            />
          )}
          <Fields
            fields={[
              { key: "label", label: "Device label", required: true },
              {
                key: "register_id",
                label: "Register",
                type: "select",
                options: meta.registers,
                required: true,
              },
              {
                key: "max_sale_amount",
                label: "Maximum offline sale amount",
                type: "number",
                required: true,
              },
            ]}
            value={form}
            onChange={setForm}
          />
          <div className="form-actions">
            <Button type="submit" busy={action.busy}>
              Authorize device
            </Button>
          </div>
        </form>
      </Dialog>
      
    </>
  );
}
