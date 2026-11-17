"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError, loadIdentity } from "@/lib/api-client";

/** Sign in. A cart filled before signing in comes with you (the API adopts it). */
export default function LoginPage() {
  const router = useRouter();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ customer: { first_name: string } }>(
        "/auth/login",
        {
          method: "POST",
          body: { email: form.email.trim(), password: form.password },
        },
      );
      // The session cookie is set; reload the identity so the CSRF token and the
      // topbar agree with it before we navigate.
      await loadIdentity();
      window.dispatchEvent(new Event("auth:changed"));
      window.dispatchEvent(new Event("cart:updated"));
      const next = new URLSearchParams(window.location.search).get("next");
      router.push(next && next.startsWith("/") ? next : "/account");
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.code === "UNAUTHORIZED" || caught.status === 401
            ? "That email and password do not match an account."
            : caught.message
          : "Could not sign in",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="card auth-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Your account</span>
            <h3>Sign in</h3>
            <p>Keep your orders and addresses together.</p>
          </div>
        </div>
        <form className="card-content" onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={form.email}
              onChange={(event) =>
                setForm({ ...form, email: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={form.password}
              onChange={(event) =>
                setForm({ ...form, password: event.target.value })
              }
            />
          </div>
          {error ? <div className="error-card">{error}</div> : null}
          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <p className="muted small" style={{ marginTop: 12 }}>
            New here? <Link href="/account/register">Create an account</Link>.
            Your cart and any guest order stay with you.
          </p>
        </form>
      </div>
    </main>
  );
}
