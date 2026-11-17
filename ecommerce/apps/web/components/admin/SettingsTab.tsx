"use client";

import { useCallback, useEffect, useState } from "react";
import { Panel, StatCard, Status } from "@/components/admin/atoms";
import type { StoreSettings } from "@/components/admin/types";
import { useToast } from "@/components/ui/Toast";
import { api, ApiError } from "@/lib/api-client";

/**
 * Store settings the API actually accepts (PUT /admin/settings/store takes the
 * name and the support email), plus a read-only view of everything else the
 * store is configured with — so the ERP switch and its env-driven values are
 * visible without shell access.
 */
export function SettingsTab({ refreshToken }: { refreshToken: number }) {
  const { toast } = useToast();
  const [data, setData] = useState<StoreSettings | null>(null);
  const [form, setForm] = useState({ name: "", support_email: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<StoreSettings>("/admin/settings");
      setData(next);
      const store = (next.settings.store ?? {}) as {
        name?: string;
        support_email?: string;
      };
      setForm({
        name: store.name ?? "",
        support_email: store.support_email ?? "",
      });
    } catch (caught) {
      toast({
        title: "Could not load settings",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/admin/settings/store", {
        method: "PUT",
        body: {
          name: form.name,
          support_email: form.support_email || undefined,
        },
      });
      toast({ title: "Store settings saved" });
      await load();
    } catch (caught) {
      toast({
        title: "Could not save the settings",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  if (loading && !data) {
    return (
      <section role="tabpanel" id="panel-settings">
        <div className="skeleton tall" style={{ height: "9rem" }} />
      </section>
    );
  }

  const settings = data?.settings ?? {};
  const store = (settings.store ?? {}) as Record<string, unknown>;
  const otherKeys = Object.keys(settings).filter((key) => key !== "store");

  return (
    <section role="tabpanel" id="panel-settings" aria-labelledby="tab-settings">
      <div className="stat-grid">
        <StatCard
          label="ERP integration"
          value={data?.erp.enabled ? "Enabled" : "Disabled"}
          footnote={
            data?.erp.enabled ? "adapter live" : "set ERP_* and restart"
          }
          hint={<Status value={data?.erp.enabled ? "active" : "draft"} />}
        />
        <StatCard
          label="Capabilities verified"
          value={data?.erp.capabilities_verified ?? "—"}
          footnote="of 27 in the contract"
        />
        <StatCard
          label="Capabilities missing"
          value={data?.erp.capabilities_missing ?? "—"}
          footnote="blocked on the ERP side"
        />
        <StatCard
          label="Settings keys"
          value={Object.keys(settings).length}
          footnote="stored in app_setting"
        />
      </div>

      <div className="split">
        <form className="card" onSubmit={save}>
          <div className="card-heading">
            <div>
              <h3>Storefront</h3>
              <p>The name and support address the shop publishes.</p>
            </div>
          </div>
          <div className="card-content">
            <div className="field">
              <label htmlFor="store-name">Store name</label>
              <input
                id="store-name"
                required
                minLength={1}
                maxLength={120}
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
              />
              <small>Shown on receipts and in the storefront footer.</small>
            </div>
            <div className="field">
              <label htmlFor="support-email">Support email (optional)</label>
              <input
                id="support-email"
                type="email"
                maxLength={255}
                value={form.support_email}
                onChange={(event) =>
                  setForm({ ...form, support_email: event.target.value })
                }
              />
              <small>Where customers are told to write about an order.</small>
            </div>
            <div className="form-actions">
              <button className="btn primary" type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save settings"}
              </button>
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => void load()}
                disabled={saving}
              >
                Reload
              </button>
            </div>
          </div>
        </form>

        <div className="stack">
          <Panel
            title="Store record"
            note="Everything currently stored under the store key."
          >
            <div className="list">
              {Object.entries(store).length === 0 ? (
                <p className="muted small">Nothing stored yet.</p>
              ) : (
                Object.entries(store).map(([key, value]) => (
                  <div className="list-row" key={key}>
                    <span className="muted small" style={{ flex: 1 }}>
                      {key}
                    </span>
                    <span className="mono">
                      {typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </Panel>

          <Panel
            title="Other settings"
            note="Read-only here: these come from the environment and migrations."
          >
            <div className="list">
              {otherKeys.length === 0 ? (
                <p className="muted small">No other keys.</p>
              ) : (
                otherKeys.map((key) => (
                  <div className="list-row" key={key}>
                    <span className="muted small" style={{ flex: 1 }}>
                      {key}
                    </span>
                    <span className="mono">
                      {typeof settings[key] === "object"
                        ? JSON.stringify(settings[key])
                        : String(settings[key])}
                    </span>
                  </div>
                ))
              )}
            </div>
            <p className="card-note" style={{ margin: "10px 0 0" }}>
              ERP credentials are never returned by this endpoint — only whether
              the integration is enabled and how many of its capabilities the
              adapter has verified.
            </p>
          </Panel>
        </div>
      </div>
    </section>
  );
}
