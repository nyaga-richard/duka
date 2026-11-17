"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, loadIdentity, newIdempotencyKey } from "@/lib/api-client";

interface OrderRow {
  order_id: number;
  order_number: string;
  status: string;
  payment_status: string;
  order_total: string;
  email: string | null;
  placed_at: string;
  line_count: number;
}

interface OrderDetail {
  order_id: number;
  order_number: string;
  status: string;
  payment_status: string;
  totals: { total: string; subtotal: string; shipping: string };
  items: Array<{ product_name: string; quantity: number; line_total: string }>;
  payments: Array<{ amount: string; payment_status: string; provider_reference: string }>;
}

const money = (value: string | number) => `KES ${Number(value).toLocaleString("en-KE")}`;

/** One place that decides how a status reads: tone + label. */
function tone(status: string): string {
  const value = status.toLowerCase();
  if (["paid", "fulfilled", "delivered", "completed", "captured"].some((word) => value.includes(word))) return "ok";
  if (["cancel", "refund", "fail", "void"].some((word) => value.includes(word))) return "danger";
  if (["pending", "await", "partial", "hold", "unpaid"].some((word) => value.includes(word))) return "warn";
  return "accent";
}

function Status({ value }: { value: string }) {
  return <span className={`badge ${tone(value)}`}>{value.replace(/_/g, " ")}</span>;
}

export default function AdminPage() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [selected, setSelected] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [payment, setPayment] = useState({ amount: "", reference: "" });
  const [refund, setRefund] = useState({ amount: "", reason: "" });

  const loadOrders = useCallback(async () => {
    try {
      const data = await api<{ items: OrderRow[] }>("/admin/orders?limit=25");
      setOrders(data.items);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) setSignedIn(false);
      else setError(caught instanceof ApiError ? caught.message : "Could not load orders");
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const identity = await loadIdentity();
      const isAdmin = identity?.kind === "admin";
      setSignedIn(isAdmin);
      if (isAdmin) await loadOrders();
    })();
  }, [loadOrders]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api("/admin/auth/login", { method: "POST", body: { email, password } });
      setSignedIn(true);
      await loadOrders();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Sign-in failed");
    }
  }

  async function openOrder(orderId: number) {
    setError(null);
    try {
      const detail = await api<OrderDetail>(`/admin/orders/${orderId}`);
      setSelected(detail);
      setPayment({ amount: detail.totals.total, reference: "" });
      setRefund({ amount: "", reason: "" });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not open the order");
    }
  }

  async function recordPayment(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setError(null);
    setNotice(null);
    try {
      await api(`/admin/orders/${selected.order_id}/payments`, {
        method: "POST",
        body: { amount: payment.amount, reference: payment.reference },
      });
      setNotice("Payment recorded.");
      await openOrder(selected.order_id);
      await loadOrders();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not record the payment");
    }
  }

  async function requestRefund(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setError(null);
    setNotice(null);
    try {
      await api(`/admin/orders/${selected.order_id}/refunds`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        body: { amount: refund.amount, reason: refund.reason },
      });
      setNotice("Refund requested. It is recorded and awaiting settlement.");
      await openOrder(selected.order_id);
      await loadOrders();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not request the refund");
    }
  }

  if (signedIn === null) {
    return (
      <main className="narrow">
        <div className="panel">
          <div className="skeleton line" style={{ width: "45%", marginBottom: "0.9rem" }} />
          <div className="skeleton" style={{ height: "5rem" }} />
        </div>
      </main>
    );
  }

  if (!signedIn) {
    return (
      <main className="narrow">
        <span className="eyebrow small muted" style={{ textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Staff area
        </span>
        <h1 style={{ fontSize: "1.7rem" }}>Sign in</h1>
        <p className="lede">A separate identity realm from customer accounts.</p>
        {error ? <div className="notice error">{error}</div> : null}
        <form className="panel" onSubmit={signIn}>
          <div className="field">
            <label htmlFor="admin-email">Email</label>
            <input
              id="admin-email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="admin-password">Password</label>
            <input
              id="admin-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <button type="submit" className="block">
            Sign in
          </button>
        </form>
        <p className="small muted" style={{ marginTop: "1rem" }}>
          Create the first administrator with <code>ADMIN_BOOTSTRAP_EMAIL</code> and{" "}
          <code>ADMIN_BOOTSTRAP_PASSWORD</code>, then run <code>npm run db:seed</code>.
        </p>
      </main>
    );
  }

  const recorded = orders.reduce((sum, order) => sum + Number(order.order_total || 0), 0);
  const awaiting = orders.filter((order) => !/paid|captured|refund/i.test(order.payment_status)).length;

  return (
    <main>
      <div className="toolbar">
        <div>
          <h1 style={{ margin: 0, fontSize: "1.7rem" }}>Orders</h1>
          <p className="lede" style={{ margin: 0 }}>
            Record manual payments, follow fulfilment and inspect what the storefront captured.
          </p>
        </div>
        <span className="grow" />
        <button className="secondary" type="button" onClick={() => void loadOrders()}>
          Refresh
        </button>
      </div>

      {error ? <div className="notice error">{error}</div> : null}
      {notice ? <div className="notice ok">{notice}</div> : null}

      <div className="stat-row">
        <div className="stat">
          <div className="k">Orders loaded</div>
          <div className="v">{orders.length}</div>
        </div>
        <div className="stat">
          <div className="k">Recorded value</div>
          <div className="v">{money(recorded)}</div>
        </div>
        <div className="stat">
          <div className="k">Awaiting payment</div>
          <div className="v">{awaiting}</div>
        </div>
      </div>

      <div className="split">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Status</th>
                <th>Payment</th>
                <th className="num">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No orders yet. Orders placed on the storefront appear here.
                  </td>
                </tr>
              ) : (
                orders.map((order) => (
                  <tr key={order.order_id}>
                    <td>
                      <strong>{order.order_number}</strong>
                      <div className="small muted">
                        {order.email ?? "guest"} · {order.line_count} line{order.line_count === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td>
                      <Status value={order.status} />
                    </td>
                    <td>
                      <Status value={order.payment_status} />
                    </td>
                    <td className="num price">{money(order.order_total)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="secondary" type="button" onClick={() => openOrder(order.order_id)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <aside>
          {!selected ? (
            <div className="notice info">Select an order to record a payment or a refund.</div>
          ) : (
            <div className="panel">
              <div className="toolbar" style={{ marginTop: 0 }}>
                <h3 style={{ margin: 0 }}>{selected.order_number}</h3>
                <span className="grow" />
                <Status value={selected.status} />
              </div>

              <div className="totals">
                <span>Payment</span>
                <Status value={selected.payment_status} />
              </div>
              <div className="totals">
                <span>Subtotal</span>
                <span className="price">{money(selected.totals.subtotal)}</span>
              </div>
              <div className="totals">
                <span>Delivery</span>
                <span className="price">{money(selected.totals.shipping)}</span>
              </div>
              <div className="totals grand">
                <span>Total</span>
                <span className="price">{money(selected.totals.total)}</span>
              </div>

              <ul className="small muted" style={{ paddingLeft: "1.1rem", margin: "0.8rem 0" }}>
                {selected.items.map((item, index) => (
                  <li key={index}>
                    {item.quantity} × {item.product_name}
                  </li>
                ))}
              </ul>

              {selected.payments.length ? (
                <p className="small muted">
                  Captured:{" "}
                  {selected.payments
                    .map((entry) => `${entry.provider_reference} (${entry.payment_status})`)
                    .join(", ")}
                </p>
              ) : null}

              <form onSubmit={recordPayment} style={{ marginTop: "0.8rem" }}>
                <h4 style={{ fontSize: "0.92rem" }}>Record a manual payment</h4>
                <div className="field">
                  <label htmlFor="amount">Amount (KES)</label>
                  <input
                    id="amount"
                    required
                    inputMode="decimal"
                    value={payment.amount}
                    onChange={(event) => setPayment({ ...payment, amount: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="reference">Reference (bank slip, receipt)</label>
                  <input
                    id="reference"
                    required
                    value={payment.reference}
                    onChange={(event) => setPayment({ ...payment, reference: event.target.value })}
                  />
                </div>
                <button type="submit" className="block">
                  Record payment
                </button>
              </form>

              <form
                onSubmit={requestRefund}
                style={{ marginTop: "1.2rem", borderTop: "1px solid var(--line)", paddingTop: "0.9rem" }}
              >
                <h4 style={{ fontSize: "0.92rem" }}>Refund a captured payment</h4>
                <div className="field">
                  <label htmlFor="refund-amount">Amount (KES)</label>
                  <input
                    id="refund-amount"
                    required
                    inputMode="decimal"
                    value={refund.amount}
                    onChange={(event) => setRefund({ ...refund, amount: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="refund-reason">Reason</label>
                  <input
                    id="refund-reason"
                    required
                    minLength={5}
                    value={refund.reason}
                    onChange={(event) => setRefund({ ...refund, reason: event.target.value })}
                  />
                </div>
                <button type="submit" className="secondary block">
                  Request refund
                </button>
              </form>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
