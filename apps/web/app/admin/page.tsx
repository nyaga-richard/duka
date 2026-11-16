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

  if (signedIn === null) return <main><p className="muted">Checking session…</p></main>;

  if (!signedIn) {
    return (
      <main style={{ maxWidth: 420 }}>
        <h1>Staff sign-in</h1>
        <p className="lede">Separate identity realm from customer accounts.</p>
        {error ? <div className="notice error">{error}</div> : null}
        <form className="card" style={{ padding: "1.1rem" }} onSubmit={signIn}>
          <div className="field">
            <label htmlFor="admin-email">Email</label>
            <input id="admin-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="admin-password">Password</label>
            <input id="admin-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          <button type="submit" style={{ width: "100%" }}>Sign in</button>
        </form>
        <p className="muted">
          Create the first administrator with <code>ADMIN_BOOTSTRAP_EMAIL</code> and <code>ADMIN_BOOTSTRAP_PASSWORD</code>, then run{" "}
          <code>npm run db:seed</code>.
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Orders</h1>
      <p className="lede">Record manual payments, follow fulfilment and inspect what the storefront captured.</p>
      {error ? <div className="notice error">{error}</div> : null}
      {notice ? <div className="notice ok">{notice}</div> : null}

      <div className="split">
        <div>
          <table>
            <thead>
              <tr><th>Order</th><th>Status</th><th>Payment</th><th>Total</th><th /></tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr><td colSpan={5} className="muted">No orders yet.</td></tr>
              ) : (
                orders.map((order) => (
                  <tr key={order.order_id}>
                    <td>
                      <strong>{order.order_number}</strong>
                      <div className="muted">{order.email ?? "guest"}</div>
                    </td>
                    <td><span className="pill">{order.status}</span></td>
                    <td>{order.payment_status}</td>
                    <td className="price">KES {Number(order.order_total).toLocaleString("en-KE")}</td>
                    <td><button className="secondary" onClick={() => openOrder(order.order_id)}>Open</button></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div className="toolbar">
            <button className="secondary" onClick={() => void loadOrders()}>Refresh</button>
          </div>
        </div>

        <aside>
          {!selected ? (
            <div className="notice info">Select an order to record a payment or a refund.</div>
          ) : (
            <div className="card" style={{ padding: "1.1rem" }}>
              <h3 style={{ marginTop: 0 }}>{selected.order_number}</h3>
              <div className="totals"><span>Status</span><span className="pill">{selected.status}</span></div>
              <div className="totals"><span>Payment</span><span>{selected.payment_status}</span></div>
              <div className="totals grand"><span>Total</span><span>KES {Number(selected.totals.total).toLocaleString("en-KE")}</span></div>
              <ul className="muted" style={{ paddingLeft: "1.1rem" }}>
                {selected.items.map((item, index) => (
                  <li key={index}>{item.quantity} × {item.product_name}</li>
                ))}
              </ul>
              {selected.payments.length ? (
                <p className="muted">
                  Captured: {selected.payments.map((entry) => `${entry.provider_reference} (${entry.payment_status})`).join(", ")}
                </p>
              ) : null}

              <form onSubmit={recordPayment} style={{ marginTop: "0.8rem" }}>
                <h4 style={{ marginBottom: "0.4rem" }}>Record a manual payment</h4>
                <div className="field">
                  <label htmlFor="amount">Amount (KES)</label>
                  <input id="amount" required value={payment.amount} onChange={(event) => setPayment({ ...payment, amount: event.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="reference">Reference (bank slip, receipt)</label>
                  <input id="reference" required value={payment.reference} onChange={(event) => setPayment({ ...payment, reference: event.target.value })} />
                </div>
                <button type="submit" style={{ width: "100%" }}>Record payment</button>
              </form>

              <form onSubmit={requestRefund} style={{ marginTop: "1.2rem", borderTop: "1px solid var(--line)", paddingTop: "0.9rem" }}>
                <h4 style={{ marginBottom: "0.4rem" }}>Refund a captured payment</h4>
                <div className="field">
                  <label htmlFor="refund-amount">Amount (KES)</label>
                  <input id="refund-amount" required value={refund.amount} onChange={(event) => setRefund({ ...refund, amount: event.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="refund-reason">Reason</label>
                  <input id="refund-reason" required minLength={5} value={refund.reason} onChange={(event) => setRefund({ ...refund, reason: event.target.value })} />
                </div>
                <button type="submit" className="secondary" style={{ width: "100%" }}>Request refund</button>
              </form>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
