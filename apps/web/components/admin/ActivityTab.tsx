"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyRow, Panel } from "@/components/admin/atoms";
import { shortId, when, type AuditRow } from "@/components/admin/types";
import { useToast } from "@/components/ui/Toast";
import { api, ApiError } from "@/lib/api-client";

const ENTITY_TYPES = [
  "",
  "order",
  "payment",
  "shipment",
  "product",
  "review",
  "app_setting",
  "erp_sync",
  "customer",
];

/**
 * The audit trail. Every money move and status change the desk performs lands
 * here — this is the read side of the same table `audit()` writes to.
 */
export function ActivityTab({ refreshToken }: { refreshToken: number }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [entityType, setEntityType] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (type: string) => {
      setLoading(true);
      try {
        const search = new URLSearchParams({ limit: "50", page: "1" });
        if (type) search.set("entity_type", type);
        const data = await api<{ items: AuditRow[] }>(
          `/admin/audit-logs?${search.toString()}`,
        );
        setRows(data.items);
      } catch (caught) {
        toast({
          title: "Could not load the audit trail",
          description: caught instanceof ApiError ? caught.message : undefined,
          variant: "error",
        });
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load(entityType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  return (
    <section role="tabpanel" id="panel-activity" aria-labelledby="tab-activity">
      <Panel flush>
        <div className="table-toolbar">
          <h2 style={{ fontSize: 14 }}>Audit trail</h2>
          <div className="toolbar-filters">
            <select
              aria-label="Filter by entity type"
              value={entityType}
              onChange={(event) => {
                setEntityType(event.target.value);
                void load(event.target.value);
              }}
            >
              {ENTITY_TYPES.map((type) => (
                <option key={type || "all"} value={type}>
                  {type ? type.replace(/_/g, " ") : "All entities"}
                </option>
              ))}
            </select>
            <span className="muted small">
              {loading ? "Loading…" : `${rows.length} entries`}
            </span>
          </div>
        </div>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Entity</th>
                <th>Actor</th>
                <th>Request</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={5}>
                  {loading
                    ? "Loading the trail…"
                    : "Nothing recorded yet. Payments, refunds, shipments and status moves appear here."}
                </EmptyRow>
              ) : (
                rows.map((row) => (
                  <tr key={row.audit_id}>
                    <td>
                      <strong style={{ fontSize: 11.5 }}>
                        {row.action.replace(/[._]/g, " ")}
                      </strong>
                    </td>
                    <td>
                      {row.entity_type.replace(/_/g, " ")}
                      <div className="muted tiny mono">
                        {shortId(row.entity_id)}
                      </div>
                    </td>
                    <td>
                      {row.actor_type}
                      <div className="muted tiny mono">
                        {shortId(row.actor_id)}
                      </div>
                    </td>
                    <td className="muted tiny mono">
                      {shortId(row.request_id)}
                    </td>
                    <td className="muted small">{when(row.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="card-note">
          Newest first. The trail is append-only: nothing in the desk edits or
          deletes it.
        </p>
      </Panel>
    </section>
  );
}
