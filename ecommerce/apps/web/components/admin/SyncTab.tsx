"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyRow, Panel, StatCard, Status } from "@/components/admin/atoms";
import {
  shortId,
  when,
  type ErpMapping,
  type ProbeResult,
  type SyncOverview,
} from "@/components/admin/types";
import { useToast } from "@/components/ui/Toast";
import { api, ApiError } from "@/lib/api-client";

function summarise(value: unknown): string {
  if (!value || typeof value !== "object") return "done";
  return Object.entries(value as Record<string, unknown>)
    .slice(0, 4)
    .map(
      ([key, entry]) =>
        `${key}: ${typeof entry === "object" ? JSON.stringify(entry) : String(entry)}`,
    )
    .join(" · ");
}

/**
 * ERP sync: what the queue is doing, what the adapter has verified, and the
 * four actions an operator actually needs — probe, pull catalogue, pull stock,
 * drain the queue. All of them call the API's own endpoints; nothing is faked
 * when the integration is switched off.
 */
export function SyncTab({ refreshToken }: { refreshToken: number }) {
  const { toast } = useToast();
  const [overview, setOverview] = useState<SyncOverview | null>(null);
  const [mappings, setMappings] = useState<ErpMapping[]>([]);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [next, map] = await Promise.all([
        api<SyncOverview>("/admin/sync/overview"),
        api<{ items: ErpMapping[] }>(
          "/admin/erp/mappings?limit=10&page=1",
        ).catch(() => ({ items: [] })),
      ]);
      setOverview(next);
      setMappings(map.items ?? []);
    } catch (caught) {
      toast({
        title: "Could not load the sync overview",
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

  async function run(
    key: string,
    path: string,
    body?: unknown,
    success?: string,
  ) {
    setAction(key);
    try {
      const result = await api<any>(path, { method: "POST", body });
      if (key === "probe") setProbe(result as ProbeResult);
      toast({ title: success ?? "Done", description: summarise(result) });
      await load();
    } catch (caught) {
      toast({
        title: "That action failed",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    } finally {
      setAction(null);
    }
  }

  if (loading && !overview) {
    return (
      <section role="tabpanel" id="panel-sync">
        <div className="stat-grid">
          {[0, 1, 2, 3].map((key) => (
            <div
              className="skeleton tall"
              key={key}
              style={{ height: "5rem" }}
            />
          ))}
        </div>
      </section>
    );
  }

  if (!overview) {
    return (
      <section role="tabpanel" id="panel-sync">
        <Panel>
          <div className="empty" style={{ padding: "28px 8px" }}>
            <h2>Sync overview unavailable</h2>
            <p>Your admin role may not include the sync permission.</p>
          </div>
        </Panel>
      </section>
    );
  }

  const verified = overview.capabilities.filter(
    (capability) => capability.support === "verified",
  ).length;
  const missing = overview.capabilities.filter(
    (capability) => capability.support === "unsupported",
  ).length;

  return (
    <section role="tabpanel" id="panel-sync" aria-labelledby="tab-sync">
      <div className="stat-grid">
        <StatCard
          label="Integration"
          value={overview.enabled ? "Enabled" : "Disabled"}
          footnote={
            overview.enabled ? "Adapter answering" : "Set ERP_* and restart"
          }
          hint={<Status value={overview.enabled ? "active" : "draft"} />}
        />
        <StatCard
          label="Queued jobs"
          value={overview.jobs.queued ?? 0}
          footnote="waiting for a worker pass"
        />
        <StatCard
          label="Running"
          value={overview.jobs.running ?? 0}
          footnote="in flight now"
        />
        <StatCard
          label="Failed"
          value={overview.jobs.failed ?? 0}
          footnote="retry from the ERP side"
        />
      </div>

      <Panel
        title="Actions"
        note="Each one calls the API directly and logs to the audit trail."
        action={
          <span className="badge">
            {verified} verified · {missing} missing
          </span>
        }
      >
        <div className="toolbar-filters">
          <button
            className="btn secondary sm"
            type="button"
            disabled={action !== null}
            onClick={() =>
              run("probe", "/admin/erp/probe", undefined, "ERP probed")
            }
          >
            {action === "probe" ? "Probing…" : "Probe ERP"}
          </button>
          <button
            className="btn primary sm"
            type="button"
            disabled={action !== null || !overview.enabled}
            onClick={() =>
              run(
                "catalog",
                "/admin/sync/pull-catalog",
                undefined,
                "Catalogue pulled",
              )
            }
          >
            {action === "catalog" ? "Pulling…" : "Pull catalogue"}
          </button>
          <button
            className="btn secondary sm"
            type="button"
            disabled={action !== null || !overview.enabled}
            onClick={() =>
              run(
                "inventory",
                "/admin/sync/pull-inventory",
                undefined,
                "Stock pulled",
              )
            }
          >
            {action === "inventory" ? "Pulling…" : "Pull stock"}
          </button>
          <button
            className="btn outline sm"
            type="button"
            disabled={action !== null}
            onClick={() =>
              run(
                "process",
                "/admin/sync/process",
                { max: 10 },
                "Queue processed",
              )
            }
          >
            {action === "process" ? "Processing…" : "Process queue"}
          </button>
        </div>

        {probe ? (
          <div className="stat-tile" style={{ marginTop: 14 }}>
            <span className="stat-icon" aria-hidden="true">
              ⌁
            </span>
            <div style={{ minWidth: 0 }}>
              <span className="stat-label">Probe result</span>
              <span className="stat-value">
                {probe.enabled
                  ? probe.probed
                    ? probe.ok === false
                      ? "Reachable, unhealthy"
                      : "Reachable"
                    : "Not probed"
                  : "Integration disabled"}
              </span>
              <span
                className="stat-sub mono"
                style={{ wordBreak: "break-word" }}
              >
                {summarise(probe)}
              </span>
            </div>
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Recent sync activity"
        note="Newest 25 entries from the sync log."
        flush
      >
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Operation</th>
                <th>Status</th>
                <th className="num">Attempts</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {overview.recent_logs.length === 0 ? (
                <EmptyRow colSpan={5}>No sync activity yet.</EmptyRow>
              ) : (
                overview.recent_logs.map((log) => (
                  <tr key={log.log_id}>
                    <td>
                      {log.entity_type}
                      <div className="muted tiny">{log.direction}</div>
                    </td>
                    <td>
                      {log.operation}
                      {log.error_code ? (
                        <div className="muted tiny">{log.error_code}</div>
                      ) : null}
                    </td>
                    <td>
                      <Status value={log.status} />
                    </td>
                    <td className="num">{log.attempts}</td>
                    <td className="muted small">{when(log.started_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Entity mappings"
        note="Local ids and the ERP ids they resolve to."
        flush
      >
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Local</th>
                <th>ERP</th>
                <th>Last synced</th>
              </tr>
            </thead>
            <tbody>
              {mappings.length === 0 ? (
                <EmptyRow colSpan={4}>
                  Nothing mapped yet. Pulls and pushes create these rows.
                </EmptyRow>
              ) : (
                mappings.map((mapping) => (
                  <tr key={mapping.map_id}>
                    <td>{mapping.entity_type}</td>
                    <td className="mono">{shortId(mapping.local_id)}</td>
                    <td className="mono">{mapping.erp_id}</td>
                    <td className="muted small">
                      {when(mapping.last_synced_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="ERP capabilities"
        note="What the adapter has verified against the ERP endpoints."
        flush
      >
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Capability</th>
                <th>Endpoint</th>
                <th>Support</th>
              </tr>
            </thead>
            <tbody>
              {overview.capabilities.map((capability) => (
                <tr key={capability.id}>
                  <td className="mono">{capability.id}</td>
                  <td className="muted tiny mono">
                    {capability.endpoint ?? "—"}
                  </td>
                  <td>
                    <Status value={capability.support} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  );
}
