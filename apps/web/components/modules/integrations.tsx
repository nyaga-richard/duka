"use client";
import React, { useState, useEffect } from "react";
import {
  Plus,
  Smartphone,
  ShieldCheck,
  RefreshCw,
  ArrowUpRight,
  Check,
  WifiOff,
  Download,
  LockKeyhole,
  Monitor,
  ArrowRight,
  ChevronRight,
  ChevronLeft,
  Globe,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import {
  api,
  useWorkspace,
  currency,
  dateText,
  useQuery,
  privateStore,
  updatePrivateStore,
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

/** ------------------------------------------------------------------ */
/*  M-Pesa setup wizard: guided, field-by-field onboarding             */
/*  Styled to match the app's card/dialog design system.               */
/** ------------------------------------------------------------------ */
function MpesaSetupWizard({
  open,
  onComplete,
  onClose,
  existing,
}: {
  open: boolean;
  onComplete: () => void;
  onClose: () => void;
  existing: any;
}) {
  const [step, setStep] = useState(1);
  const [env, setEnv] = useState<"sandbox" | "production">(
    existing?.base_url?.includes("api.safaricom.co.ke") ? "production" : "sandbox",
  );
  const [values, setValues] = useState({
    consumer_key: "",
    consumer_secret: "",
    shortcode: existing?.shortcode ?? "",
    passkey: existing?.passkey ?? "",
    callback_secret: existing?.callback_secret ?? "",
    transaction_type: existing?.transaction_type ?? "CustomerPayBillOnline",
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const requiredFilled =
    values.consumer_key &&
    values.consumer_secret &&
    values.shortcode &&
    values.passkey &&
    values.callback_secret;

  const baseUrl = env === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(values.consumer_key + ":" + values.consumer_secret).toString("base64"),
        },
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      if (response.ok && data.access_token) {
        setTestResult({ ok: true, msg: "Credentials validated with Daraja." });
      } else {
        setTestResult({ ok: false, msg: data.errorMessage || "Daraja rejected the credentials." });
      }
    } catch (e: any) {
      setTestResult({ ok: false, msg: e.message || "Could not reach Daraja." });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaveError(null);
    setSaving(true);
    try {
      await api("/integrations/config", {
        method: "PUT",
        body: {
          provider: "mpesa",
          enabled: true,
          config: {
            consumer_key: values.consumer_key.trim(),
            consumer_secret: values.consumer_secret.trim(),
            shortcode: values.shortcode.trim(),
            passkey: values.passkey.trim(),
            callback_secret: values.callback_secret.trim(),
            transaction_type: values.transaction_type,
            base_url: baseUrl,
          },
        },
      });
      onComplete();
    } catch (e: any) {
      setSaveError(e?.message ?? "Failed to save configuration.");
    } finally {
      setSaving(false);
    }
  }

  const stepMeta = [
    { n: 1, title: "1 · Environment", sub: "Sandbox to test, Production for live payments" },
    { n: 2, title: "2 · Daraja credentials", sub: "Consumer key, secret, shortcode, passkey, callback secret" },
    { n: 3, title: "3 · Test connection", sub: "We validate your credentials with Daraja before saving" },
    { n: 4, title: "4 · Enable", sub: "M-Pesa Express appears at the POS once enabled" },
  ];

  return (
    <Dialog open={open} onClose={onClose} title="Set up M-Pesa payments" description="Step-by-step connection to Safaricom Daraja." wide>
      <div className="dialog-content">
        {/* Step indicator */}
        <div className="field" style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {stepMeta.map((s, i) => (
              <div key={s.n} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  className={`badge ${step >= s.n ? "success" : "neutral"}`}
                  style={{ width: 26, height: 26, display: "grid", placeItems: "center", fontSize: 11 }}
                >
                  {step >= s.n ? s.n : i + 1}
                </div>
                {i < stepMeta.length - 1 && <div style={{ width: 1, height: 16, background: "var(--line)" }} />}
              </div>
            ))}
          </div>
          <p style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>{stepMeta[step - 1].sub}</p>
        </div>

        <h2 style={{ fontSize: 16, marginBottom: 6, color: "var(--text)" }}>{stepMeta[step - 1].title}</h2>

        {/* Step 1: Environment */}
        {step === 1 ? (
          <div className="field" style={{ marginBottom: 16 }}>
            <span style={{ fontWeight: 500, fontSize: 11, color: "var(--text)" }}>Environment</span>
            <div style={{ display: "flex", gap: 12 }}>
              <button
                className={`btn ${env === "sandbox" ? "secondary" : "ghost"}`}
                onClick={() => setEnv("sandbox")}
                style={{ padding: "12px 16px", minHeight: 44 }}
              >
                <Globe size={16} style={{ marginRight: 8 }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>Sandbox (test)</div>
                  <div style={{ fontSize: 10, color: "var(--muted)" }}>No real money moves</div>
                </div>
              </button>
              <button
                className={`btn ${env === "production" ? "secondary" : "ghost"}`}
                onClick={() => setEnv("production")}
                style={{ padding: "12px 16px", minHeight: 44 }}
              >
                <ShieldCheck size={16} style={{ marginRight: 8 }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>Production (live)</div>
                  <div style={{ fontSize: 10, color: "var(--muted)" }}>Real customer payments</div>
                </div>
              </button>
            </div>
            <small style={{ color: "var(--muted)", marginTop: 6, display: "block" }}>
              The callback URL Daraja calls is pre-configured from your public host. You only need
              the API credentials below.
            </small>
          </div>
        ) : null}

        {/* Step 2: Credentials */}
        {step === 2 ? (
          <>
            <Fields
              fields={[
                {
                  key: "consumer_key",
                  label: "Consumer key",
                  type: "text",
                  required: true,
                  help: "From your Daraja app (My Apps → App credentials).",
                },
                {
                  key: "consumer_secret",
                  label: "Consumer secret",
                  type: "password",
                  required: true,
                  help: "From your Daraja app (My Apps → App credentials).",
                },
                {
                  key: "shortcode",
                  label: "Shortcode (Pay Bill or Till number)",
                  type: "text",
                  required: true,
                  help: "5–6 digits. Sandbox uses the test shortcode from the simulator.",
                },
                {
                  key: "passkey",
                  label: "Passkey (Lipa Na M-Pesa)",
                  type: "password",
                  required: true,
                  help: "Sandbox: from the simulator test data. Production: sent by Safaricom after go-live.",
                },
                {
                  key: "callback_secret",
                  label: "Callback secret (32+ characters)",
                  type: "password",
                  required: true,
                  help: "Any strong secret you create. It signs callbacks so only Daraja can reach your server.",
                },
                {
                  key: "transaction_type",
                  label: "Transaction type",
                  type: "select",
                  options: [
                    { id: "CustomerPayBillOnline", name: "Pay Bill (CustomerPayBillOnline)" },
                    { id: "CustomerBuyGoodsOnline", name: "Buy Goods / Till (CustomerBuyGoodsOnline)" },
                  ],
                  required: true,
                },
              ]}
              value={values}
              onChange={setValues}
            />
            <div className="field" style={{ marginTop: 12 }}>
              <span style={{ fontWeight: 500, fontSize: 11, color: "var(--text)" }}>Callback URL</span>
              <div style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 7, padding: 11, fontSize: 11, fontFamily: "monospace", wordBreak: "break-all" }}>
                {`${window.location.origin}/api/v1/integrations/mpesa/callback`}
              </div>
              <small style={{ color: "var(--muted)", marginTop: 6, display: "block" }}>
                Auto-configured from your public host. No changes needed.
              </small>
            </div>
          </>
        ) : null}

        {/* Step 3: Test connection */}
        {step === 3 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {testResult && (
              <div
                className={`card`}
                style={{
                  padding: 16,
                  borderLeft: `4px solid ${testResult.ok ? "var(--green)" : "var(--danger)"}`,
                  background: testResult.ok ? "var(--green-light)" : "var(--surface-2)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {testResult.ok ? <CheckCircle2 size={16} style={{ color: "var(--green)" }} /> : <AlertCircle size={16} style={{ color: "var(--danger)" }} />}
                  <span style={{ fontSize: 11, fontWeight: 500 }}>{testResult.msg}</span>
                </div>
              </div>
            )}
            <Button
              variant="primary"
              busy={testing}
              onClick={testConnection}
              disabled={!requiredFilled}
              style={{ width: "100%" }}
            >
              {testing ? "Validating with Daraja…" : "Test connection with Daraja"}
            </Button>
            {!requiredFilled && (
              <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
                Fill in all credential fields above to enable testing.
              </p>
            )}
            {testResult?.ok && (
              <p style={{ fontSize: 11, color: "var(--green)", marginTop: 8, fontWeight: 500 }}>
                Your credentials are valid. Proceed to enable.
              </p>
            )}
          </div>
        )}

        {/* Step 4: Enable */}
        {step === 4 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="card" style={{ padding: 18, background: "var(--green-light)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Smartphone size={20} style={{ color: "var(--green)" }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Ready to enable M-Pesa</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>Credentials encrypted at rest, never shown back</div>
                </div>
              </div>
              <div style={{ marginTop: 14, display: "grid", gap: 8, fontSize: 11, color: "var(--muted)" }}>
                <div><strong>Environment:</strong> {env.charAt(0).toUpperCase() + env.slice(1)}</div>
                <div><strong>Shortcode:</strong> {values.shortcode}</div>
                <div><strong>Transaction type:</strong> {values.transaction_type}</div>
                <div><strong>Status:</strong> Will be enabled for this business</div>
              </div>
            </div>
          </div>
        )}

        <div className="form-actions" style={{ marginTop: 24, justifyContent: "space-between" }}>
          {step > 1 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              <ChevronLeft size={14} /> Back
            </Button>
          )}
          {step < 4 ? (
            <Button
              variant="primary"
              busy={saving}
              disabled={step === 3 && !testResult?.ok ? true : step === 2 && !requiredFilled}
              onClick={() =>
                step === 3 ? (testResult?.ok ? setStep(4) : null) : setStep(step + 1)
              }
            >
              {step === 3 && testResult?.ok ? "Enable M-Pesa" : "Next"}
            </Button>
          ) : (
            <Button variant="primary" busy={saving} onClick={save}>
              Save and enable
            </Button>
          )}
          {step === 4 && (
            <Button variant="ghost" onClick={() => setStep(1)}>
              Start over
            </Button>
          )}
        </div>
        {saveError && (
          <div style={{ marginTop: 16 }}>
            <ErrorCard error={{ message: saveError }} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** ------------------------------------------------------------------ */
/*  Integrations page                                                   */
/** ------------------------------------------------------------------ */
export function IntegrationsPage() {
  const { meta } = useWorkspace();
  const status = useQuery<any>("/integrations/status");
  const config = useQuery<any>("/integrations/config");
  const [setupOpen, setSetupOpen] = useState(false);
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

  const mpesa = config.data?.mpesa;
  const etims = config.data?.etims;
  const mpesaConfigured = status.data?.mpesa_mode === "daraja" || mpesa?.configured;
  const mpesaEnabled = mpesa?.enabled ?? false;
  const mpesaCreds = status.data?.mpesa_credentials_configured;

  const canConfigure = meta.actor.permissions.includes("integrations.manage");

  const mpesaBadge = mpesaEnabled
    ? "active"
    : mpesaConfigured
      ? "pending"
      : "neutral";
  const mpesaBadgeLabel = mpesaEnabled
    ? "Enabled"
    : mpesaConfigured
      ? "Configured, not enabled"
      : "Not configured";

  const etimsBadge = status.data?.fiscal_mode === "adapter" ? "pending" : "neutral";

  return (
    <>
      <PageHeading
        eyebrow="CONNECTED SERVICES"
        title="Integrations"
        description="Connect M-Pesa payments and KRA eTIMS fiscalization. No invented payment or fiscal success — every result is verified with the provider."
      >
        <Button variant="secondary" onClick={() => { list.refresh(); status.refresh(); config.refresh(); }}>
          <RefreshCw size={16} /> Refresh
        </Button>
        {!mpesaConfigured && canConfigure && (
          <Button variant="primary" onClick={() => setSetupOpen(true)}>
            <Plus size={16} /> Set up M-Pesa
          </Button>
        )}
      </PageHeading>

      {/* Status cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 }}>
        <section className="card">
          <div className="card-heading">
            <div>
              <h2 style={{ fontSize: 15, marginBottom: 4 }}>M-Pesa / Daraja</h2>
              <p style={{ fontSize: 11, color: "var(--muted)" }}>
                STK push → token-bound callback → provider query → allocation.
              </p>
            </div>
            <div className="integration-logo mpesa">
              <Smartphone size={20} />
            </div>
          </div>
          <div style={{ padding: "0 22px 18px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <Badge status={mpesaBadge}>{mpesaBadgeLabel}</Badge>
              <Badge
                status={mpesaCreds ? "active" : "neutral"}
              >
                {mpesaCreds ? "Live credentials" : "Sandbox / none"}
              </Badge>
            </div>
            <div className="form-actions" style={{ marginTop: 8 }}>
              {!mpesaConfigured && canConfigure && (
                <Button variant="ghost" onClick={() => setSetupOpen(true)}>
                  Set up now
                </Button>
              )}
              {mpesaConfigured && !mpesaEnabled && canConfigure && (
                <Button
                  variant="secondary"
                  busy={action.busy}
                  onClick={() =>
                    action.run(
                      () =>
                        api("/integrations/config", {
                          method: "PUT",
                          body: { provider: "mpesa", enabled: true },
                        }).then(() => {
                          config.refresh();
                          status.refresh();
                          return {};
                        }),
                      "M-Pesa enabled.",
                    )
                  }
                >
                  Enable
                </Button>
              )}
              {mpesaEnabled && canConfigure && (
                <Button
                  variant="secondary"
                  busy={action.busy}
                  onClick={() =>
                    action.run(
                      () =>
                        api("/integrations/config", {
                          method: "PUT",
                          body: { provider: "mpesa", enabled: false },
                        }).then(() => {
                          config.refresh();
                          status.refresh();
                          return {};
                        }),
                      "M-Pesa disabled.",
                    )
                  }
                >
                  Disable
                </Button>
              )}
            </div>
          </div>
          <small style={{ color: "var(--muted)", lineHeight: 1.8, display: "block", marginTop: 10 }}>
            {mpesaCreds
              ? "Credentials configured. Test with a small sale at the POS before going live."
              : mpesaConfigured
                ? "Settings saved; enable to offer M-Pesa at checkout."
                : "No live merchant credentials yet. Set up below with your Daraja values."}
          </small>
        </section>

        <section className="card">
          <div className="card-heading">
            <div>
              <h2 style={{ fontSize: 15, marginBottom: 4 }}>KRA eTIMS</h2>
              <p style={{ fontSize: 11, color: "var(--muted)" }}>
                Certified gateway adapter with idempotency, retries and failure visibility.
              </p>
            </div>
            <div className="integration-logo fiscal">
              <ShieldCheck size={20} />
            </div>
          </div>
          <div style={{ padding: "0 22px 18px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <Badge status={etimsBadge}>
                {status.data?.fiscal_mode ?? "Loading"}
              </Badge>
            </div>
            <div className="form-actions" style={{ marginTop: 8 }}>
              {etims?.configured && canConfigure && (
                <Button
                  variant={etims.enabled ? "secondary" : "primary"}
                  onClick={() =>
                    action.run(
                      () =>
                        api("/integrations/config", {
                          method: "PUT",
                          body: { provider: "etims", enabled: !etims.enabled },
                        }).then(() => {
                          config.refresh();
                          status.refresh();
                        }),
                      etims.enabled ? "eTIMS disabled." : "eTIMS enabled.",
                    )
                  }
                >
                  {etims.enabled ? "Disable" : "Enable"}
                </Button>
              )}
            </div>
          </div>
          <small style={{ color: "var(--muted)", lineHeight: 1.8, display: "block", marginTop: 10 }}>
            No direct KRA certification is claimed. OSCU/VSCU onboarding and current schema
            acceptance must be completed externally.
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
                  <h3 style={{ fontSize: 14, fontWeight: 650, margin: "0 0 2px" }}>
                    {pv === "mpesa" ? "M-Pesa credentials" : "eTIMS gateway"}
                  </h3>
                  <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted)" }}>
                    {config.loading && !config.data
                      ? "Loading configuration…"
                      : c?.configured
                        ? `Configured by ${c.updated_by} · values are never shown back.`
                        : "Not configured yet."}
                  </p>
                </div>
                <div className="integration-config-side">
                  <Badge status={c?.enabled ? "active" : "neutral"}>
                    {c?.configured ? (c.enabled ? "Enabled" : "Disabled") : "Not configured"}
                  </Badge>
                  <div className="form-actions compact">
                    {c?.configured && canConfigure && pv === "mpesa" && (
                      <Button variant="ghost" onClick={() => setSetupOpen(true)}>
                        Reconfigure
                      </Button>
                    )}
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
                              }).then(() => {
                                config.refresh();
                                status.refresh();
                                return {};
                              }),
                            c.enabled ? "Integration disabled." : "Integration enabled.",
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
        <AlertCircle size={20} />
        <p>
          Daraja callbacks are not treated as signed payment evidence.
          Successful settlement requires a server-to-provider query bound to the
          stored request and matching callback metadata. External refunds stay
          liabilities until a manager independently reconciles settlement.
          Normal PDF receipts are not fiscal invoices.
        </p>
      </div>

      <div className="page-tabs">
        <button className={tab === "mpesa" ? "active" : ""} onClick={() => setTab("mpesa")}>
          Mobile-money intents
        </button>
        <button className={tab === "fiscal" ? "active" : ""} onClick={() => setTab("fiscal")}>
          Fiscal submissions
        </button>
        <button className={tab === "refunds" ? "active" : ""} onClick={() => setTab("refunds")}>
          External refunds
        </button>
      </div>

      <section className="card">
        {list.error && <ErrorCard error={list.error} />}
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
                      render: (r) => <Badge status={r.status}>{r.status}</Badge>,
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
                      render: (r) => <Badge status={r.status}>{r.status}</Badge>,
                    },
                    { key: "provider_reference", title: "Reconciled reference" },
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
        <a href="https://developer.safaricom.co.ke/" target="_blank" rel="noreferrer">
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

      {/* M-Pesa setup wizard dialog */}
      <MpesaSetupWizard
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onComplete={() => {
          setSetupOpen(false);
          config.refresh();
          status.refresh();
        }}
        existing={mpesa}
      />

      {/* Refund confirmation dialog (existing) */}
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
    </>
  );
}

/** ------------------------------------------------------------------ */
/*  Offline page (unchanged)                                            */
/** ------------------------------------------------------------------ */
export function OfflinePage() {
  const { meta, actor, online, notify } = useWorkspace();
  const devices = useQuery<any>(online ? "/offline/devices" : null);
  const syncRecords = useQuery<any>(online ? "/offline/sync?limit=100" : null);
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
      const register = meta.registers.find((r: any) => r.id === device.register_id);
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
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
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