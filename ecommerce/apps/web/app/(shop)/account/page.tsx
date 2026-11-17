"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { money, statusTone } from "@/components/OrderDetail";
import { api, ApiError, loadIdentity } from "@/lib/api-client";

interface OrderRow {
  order_id: number;
  order_number: string;
  order_total: string;
  placed_at: string;
  status: string;
  payment_status: string;
  line_count: number;
}

interface Customer {
  customer_id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

/**
 * The account page: who you are, what you have bought, and the two things you
 * can do to it (change the password, sign out). Orders placed as a guest are
 * not here until the customer signs in with the same browser — the order lookup
 * on `/orders` remains the fallback for those.
 */
export default function AccountPage() {
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [passwords, setPasswords] = useState({
    current_password: "",
    new_password: "",
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const identity = await loadIdentity();
    if (identity?.kind !== "customer") {
      setCustomer(null);
      setLoading(false);
      return;
    }
    setCustomer(identity.customer as Customer);
    try {
      const result = await api<{ items: OrderRow[] }>("/orders?limit=20");
      setOrders(result.items ?? []);
    } catch {
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function signOut() {
    setBusy(true);
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      // A revoked session is the outcome we wanted either way.
    }
    await loadIdentity();
    window.dispatchEvent(new Event("auth:changed"));
    window.dispatchEvent(new Event("cart:updated"));
    router.push("/");
    router.refresh();
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("/auth/change-password", { method: "POST", body: passwords });
      setPasswords({ current_password: "", new_password: "" });
      setNotice("Password changed. Other devices were signed out.");
      window.dispatchEvent(new Event("auth:changed"));
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not change the password",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="auth-page">
        <div className="card auth-card">
          <div className="card-content" style={{ paddingTop: 22 }}>
            <div
              className="skeleton"
              style={{ width: "45%", marginBottom: 12 }}
            />
            <div className="skeleton" style={{ width: "70%" }} />
          </div>
        </div>
      </main>
    );
  }

  if (!customer) {
    return (
      <main className="auth-page">
        <div className="card auth-card">
          <div className="card-content">
            <span className="eyebrow">Your account</span>
            <h2 style={{ margin: "6px 0 8px" }}>You are not signed in</h2>
            <p className="muted small">
              Sign in to see your orders here, or look one up with its number
              and the email you used at checkout.
            </p>
            <div className="row" style={{ gap: 10, marginTop: 14 }}>
              <Link className="btn primary" href="/account/login">
                Sign in
              </Link>
              <Link className="btn secondary" href="/account/register">
                Create an account
              </Link>
              <Link className="btn ghost" href="/orders">
                Find an order
              </Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main>
      <nav
        className="breadcrumbs"
        aria-label="Breadcrumb"
        style={{ marginBottom: 14 }}
      >
        <Link href="/">Home</Link>
        <strong>Account</strong>
      </nav>

      <div className="page-heading">
        <div>
          <span className="eyebrow">Your account</span>
          <h1>
            {[customer.first_name, customer.last_name]
              .filter(Boolean)
              .join(" ") || "Your account"}
          </h1>
          <p>{customer.email}</p>
        </div>
        <div className="heading-actions">
          <button
            className="btn secondary sm"
            type="button"
            disabled={busy}
            onClick={signOut}
          >
            Sign out
          </button>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <div className="card">
            <div className="card-heading">
              <div>
                <h3>Your orders</h3>
                <p>Everything placed while signed in to this account.</p>
              </div>
              <Link className="btn ghost sm" href="/orders">
                Look up another
              </Link>
            </div>
            <div className="card-content">
              {orders === null ? (
                <div className="skeleton" style={{ width: "60%" }} />
              ) : orders.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>
                  No orders yet. <Link href="/shop">Browse the shop</Link> and
                  your first order will appear here.
                </p>
              ) : (
                <div className="list">
                  {orders.map((order) => (
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
        </div>

        <form className="card" onSubmit={changePassword}>
          <div className="card-heading">
            <div>
              <h3>Change the password</h3>
              <p>Other sessions are signed out when it changes.</p>
            </div>
          </div>
          <div className="card-content">
            <div className="field">
              <label htmlFor="current_password">Current password</label>
              <input
                id="current_password"
                type="password"
                required
                autoComplete="current-password"
                value={passwords.current_password}
                onChange={(event) =>
                  setPasswords({
                    ...passwords,
                    current_password: event.target.value,
                  })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="new_password">New password</label>
              <input
                id="new_password"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                value={passwords.new_password}
                onChange={(event) =>
                  setPasswords({
                    ...passwords,
                    new_password: event.target.value,
                  })
                }
              />
              <p className="muted tiny" style={{ marginTop: 4 }}>
                At least 12 characters.
              </p>
            </div>
            {error ? <div className="error-card">{error}</div> : null}
            {notice ? <div className="notice">{notice}</div> : null}
            <button className="btn primary block" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Change password"}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
