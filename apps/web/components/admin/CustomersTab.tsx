"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyRow, Panel, Status } from "@/components/admin/atoms";
import { shortId, when, type Customer } from "@/components/admin/types";
import { useToast } from "@/components/ui/Toast";
import { api, ApiError } from "@/lib/api-client";

/**
 * Registered customers, with their ERP mapping. `GET /admin/customers` is a
 * search over email and name; "Push to ERP" maps and creates one immediately
 * instead of waiting for the next sync pass.
 */
export function CustomersTab({ refreshToken }: { refreshToken: number }) {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (q: string) => {
      setLoading(true);
      try {
        const search = new URLSearchParams({ limit: "50", page: "1" });
        if (q.trim()) search.set("q", q.trim());
        const data = await api<{ items: Customer[] }>(
          `/admin/customers?${search.toString()}`,
        );
        setItems(data.items);
      } catch (caught) {
        toast({
          title: "Could not load customers",
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
    void load(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  async function pushToErp(customer: Customer) {
    setBusy(customer.customer_id);
    try {
      await api(`/admin/sync/customers/${customer.customer_id}`, {
        method: "POST",
      });
      toast({
        title: "Customer pushed to the ERP",
        description: customer.email,
      });
      await load(query);
    } catch (caught) {
      toast({
        title: "Could not push the customer",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  const withOrders = items.filter((customer) => customer.orders > 0).length;
  const mapped = items.filter((customer) => customer.erp_customer_id).length;

  return (
    <section
      role="tabpanel"
      id="panel-customers"
      aria-labelledby="tab-customers"
    >
      <Panel flush>
        <form
          className="table-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            void load(query);
          }}
        >
          <div className="search-box">
            <input
              type="search"
              placeholder="Search by email or name"
              aria-label="Search customers"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="toolbar-filters">
            <button className="btn secondary sm" type="submit">
              Search
            </button>
            <span className="muted small">
              {loading
                ? "Loading…"
                : `${items.length} shown · ${withOrders} with orders · ${mapped} mapped to the ERP`}
            </span>
          </div>
        </form>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Contact</th>
                <th className="num">Orders</th>
                <th>ERP</th>
                <th>Joined</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <EmptyRow colSpan={7}>
                  {loading
                    ? "Loading customers…"
                    : "No customers match. Customers appear here after they register or check out with an account."}
                </EmptyRow>
              ) : (
                items.map((customer) => (
                  <tr key={customer.customer_id}>
                    <td>
                      <strong>
                        {[customer.first_name, customer.last_name]
                          .filter(Boolean)
                          .join(" ") || "—"}
                      </strong>
                      <div className="muted tiny mono">
                        {shortId(customer.customer_id)}
                      </div>
                    </td>
                    <td>
                      {customer.email}
                      <div className="muted tiny">
                        {customer.phone ?? "no phone"}
                      </div>
                    </td>
                    <td className="num">{customer.orders}</td>
                    <td>
                      {customer.erp_customer_id ? (
                        <span className="badge ok">
                          #{customer.erp_customer_id}
                        </span>
                      ) : (
                        <span className="muted small">unmapped</span>
                      )}
                    </td>
                    <td className="muted small">{when(customer.created_at)}</td>
                    <td className="muted small">
                      {when(customer.last_login_at)}
                    </td>
                    <td className="num">
                      <span className="row-actions">
                        <Status value={customer.status} />
                        <button
                          className="btn outline sm"
                          type="button"
                          disabled={busy === customer.customer_id}
                          onClick={() => pushToErp(customer)}
                        >
                          {busy === customer.customer_id
                            ? "Pushing…"
                            : "Push to ERP"}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="card-note">
          Pushing a customer creates the ERP customer and stores the mapping;
          with the integration disabled the API answers with a clear error
          instead of pretending.
        </p>
      </Panel>
    </section>
  );
}
