"use client";

import Link from "next/link";
import { useState } from "react";
import { Brand } from "@/components/Brand";
import { CheckIcon } from "@/components/icons";
import { api, ApiError } from "@/lib/api-client";

/**
 * The ERP's `login-layout`: the dark story panel beside the form panel. Staff
 * identities are a separate realm from customer accounts, and this screen is
 * the only way into the desk.
 */
export function LoginScreen({
  onSignedIn,
}: {
  onSignedIn: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/admin/auth/login", {
        method: "POST",
        body: { email, password },
      });
      onSignedIn(email);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-layout">
      <div className="login-story">
        <Brand onDark label="business os" />
        <span className="story-orbit" aria-hidden="true" />
        <div className="story-copy">
          <span className="eyebrow">Store desk</span>
          <h2>The shop side of your business, with the same books.</h2>
          <p>
            Orders arrive here from the storefront, stock and prices stay owned
            by the ERP, and every payment, refund and shipment is recorded
            against the order it belongs to.
          </p>
          <div className="story-list">
            <span>
              <CheckIcon size={14} /> Record a manual payment in two fields
            </span>
            <span>
              <CheckIcon size={14} /> Ship with a carrier and a tracking number
            </span>
            <span>
              <CheckIcon size={14} /> Every move lands in the audit trail
            </span>
          </div>
          <div className="story-balances">
            <div>
              <span>Catalogue</span>
              <strong>ERP-owned</strong>
            </div>
            <div>
              <span>Payments</span>
              <strong>Manual, Phase 1</strong>
            </div>
            <div>
              <span>Currency</span>
              <strong>KES</strong>
            </div>
          </div>
        </div>
        <div className="login-story-footer">
          <span>Duka Business OS</span>
          <span>Store desk · v0.1</span>
        </div>
      </div>

      <div className="login-form-panel">
        <div className="login-form-wrap">
          <div className="mobile-brand">
            <Brand label="shop" />
          </div>
          <span className="eyebrow">Staff area</span>
          <h1>Sign in</h1>
          <p>
            A separate identity realm from customer accounts. Administrators
            reach the store desk and the ERP sync console from here.
          </p>
          {error ? <div className="error-card">{error}</div> : null}
          <form onSubmit={submit}>
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
            <button
              type="submit"
              className="btn primary lg block"
              disabled={busy}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <div className="login-options">
            <Link className="text-link" href="/">
              Back to the shop
            </Link>
            <span>Orders are recorded against this branch</span>
          </div>
        </div>
        <div className="login-copyright">
          © {new Date().getFullYear()} Duka · Payments confirmed by the store
          team
        </div>
      </div>
    </div>
  );
}
