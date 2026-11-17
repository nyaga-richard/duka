"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  OrderDetail,
  money,
  statusTone,
  type OrderView,
} from "@/components/OrderDetail";
import { ReorderButton } from "@/components/ReorderButton";
import { ChevronRightIcon } from "@/components/icons";
import { api, ApiError, loadIdentity } from "@/lib/api-client";

interface HistoryItem {
  order_id: number;
  order_number: string;
  order_total: string;
  placed_at: string;
  payment_status: string;
  status: string;
  line_count: number;
}

/**
 * Two ways to reach an order.
 *
 * Signed-in customers and guests still holding their cookie see the orders tied
 * to this browser; anyone else - and anyone on a new device - can enter the
 * order number from their receipt plus the email used at checkout, which is the
 * only credential the store handed them.
 */
export default function OrdersPage() {
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [form, setForm] = useState({ order_number: "", email: "" });
  const [found, setFound] = useState<OrderView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const identity = await loadIdentity();
      if (identity?.kind !== "customer" && identity?.kind !== "guest") {
        setHistory([]);
        return;
      }
      const result = await api<{ items: HistoryItem[] }>("/orders?limit=20");
      setHistory(result.items ?? []);
      if (identity.kind === "customer" && identity.customer?.email) {
        setForm((current) =>
          current.email
            ? current
            : { ...current, email: identity.customer.email },
        );
      }
    } catch {
      setHistory([]);
    } finally {
      setIdentityLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function lookup(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      const result = await api<{ order: OrderView }>("/orders/lookup", {
        method: "POST",
        body: {
          order_number: form.order_number.trim(),
          email: form.email.trim(),
        },
      });
      setFound(result.order);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.status === 404
            ? "No order matches that number and email. Check the confirmation email we sent you."
            : caught.message
          : "Could not look up that order",
      );
    } finally {
      setBusy(false);
    }
  }

  if (found) {
    return (
      <OrderDetail
        order={found}
        backHref="/orders"
        backLabel="All orders"
        actions={
          <ReorderButton items={found.items} className="btn secondary block" />
        }
      />
    );
  }

  return (
    <main>
      <nav
        className="breadcrumbs"
        aria-label="Breadcrumb"
        style={{ marginBottom: 14 }}
      >
        <Link href="/shop">Shop</Link>
        <ChevronRightIcon size={12} />
        <strong>Orders</strong>
      </nav>

      <div className="page-heading">
        <div>
          <span className="eyebrow">Orders</span>
          <h1>Find an order</h1>
          <p>
            Signed in? Your recent orders are below. Otherwise use the order
            number from your confirmation with the email you checked out with.
          </p>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <div className="card">
            <div className="card-heading">
              <div>
                <h3>Recent orders</h3>
                <p>
                  {identityLoaded
                    ? "Orders placed from this browser."
                    : "Loading…"}
                </p>
              </div>
            </div>
            <div className="card-content">
              {history === null ? (
                <>
                  <div
                    className="skeleton"
                    style={{ width: "60%", marginBottom: 10 }}
                  />
                  <div className="skeleton" style={{ width: "45%" }} />
                </>
              ) : history.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>
                  No orders are linked to this browser. Use the lookup on the
                  right if you ordered as a guest on another device.
                </p>
              ) : (
                <div className="list">
                  {history.map((order) => (
                    <div className="list-row" key={order.order_id}>
                      <span style={{ flex: 1 }}>
                        <Link href={`/orders/${order.order_id}`}>
                          <strong>{order.order_number}</strong>
                        </Link>
                        <div className="muted tiny">
                          {new Date(order.placed_at).toLocaleDateString()} ·{" "}
                          {order.line_count} line
                          {order.line_count === 1 ? "" : "s"}
                        </div>
                      </span>
                      <span className={`badge ${statusTone(order.status)}`}>
                        {order.status.replace(/_/g, " ")}
                      </span>
                      <span className="price small">
                        {money(order.order_total)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-content">
              <p className="muted small" style={{ margin: 0 }}>
                Payments are confirmed by the store team, and delivery timing
                depends on the option you chose at checkout.
              </p>
            </div>
          </div>
        </div>

        <form className="card" onSubmit={lookup}>
          <div className="card-heading">
            <div>
              <h3>Look up by number</h3>
              <p>Both fields must match the order exactly.</p>
            </div>
          </div>
          <div className="card-content">
            <div className="field">
              <label htmlFor="order_number">Order number</label>
              <input
                id="order_number"
                required
                autoComplete="off"
                placeholder="As shown on your confirmation, e.g. EC-20261117-00001"
                value={form.order_number}
                onChange={(event) =>
                  setForm({ ...form, order_number: event.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="lookup_email">Email used at checkout</label>
              <input
                id="lookup_email"
                type="email"
                required
                autoComplete="email"
                value={form.email}
                onChange={(event) =>
                  setForm({ ...form, email: event.target.value })
                }
              />
            </div>
            {error ? <div className="error-card">{error}</div> : null}
            <button type="submit" className="btn primary block" disabled={busy}>
              {busy ? "Looking up…" : "Find my order"}
            </button>
            <p className="muted tiny" style={{ marginTop: 10 }}>
              We ask for both so that knowing an order number alone is not
              enough to see someone else's delivery address.
            </p>
          </div>
        </form>
      </div>
    </main>
  );
}
