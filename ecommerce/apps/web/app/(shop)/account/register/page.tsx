"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError, loadIdentity } from "@/lib/api-client";

const MIN_PASSWORD = 12;

/** Create a customer account. The guest cart is adopted by the API on success. */
export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    password: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/register", {
        method: "POST",
        body: {
          email: form.email.trim(),
          password: form.password,
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        },
      });
      await loadIdentity();
      window.dispatchEvent(new Event("auth:changed"));
      window.dispatchEvent(new Event("cart:updated"));
      router.push("/account");
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.code === "EMAIL_TAKEN" || caught.status === 409
            ? "An account with that email already exists. Try signing in instead."
            : caught.message
          : "Could not create the account",
      );
    } finally {
      setBusy(false);
    }
  }

  const tooShort =
    form.password.length > 0 && form.password.length < MIN_PASSWORD;

  return (
    <main className="auth-page">
      <div className="card auth-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Your account</span>
            <h3>Create an account</h3>
            <p>Order history, saved details and a cart that follows you.</p>
          </div>
        </div>
        <form className="card-content" onSubmit={submit}>
          <div className="row" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="first_name">First name</label>
              <input
                id="first_name"
                required
                autoComplete="given-name"
                value={form.first_name}
                onChange={(event) =>
                  setForm({ ...form, first_name: event.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="last_name">Last name</label>
              <input
                id="last_name"
                required
                autoComplete="family-name"
                value={form.last_name}
                onChange={(event) =>
                  setForm({ ...form, last_name: event.target.value })
                }
              />
            </div>
          </div>
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
            <label htmlFor="phone">Phone (optional)</label>
            <input
              id="phone"
              autoComplete="tel"
              placeholder="07xx xxx xxx"
              value={form.phone}
              onChange={(event) =>
                setForm({ ...form, phone: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              minLength={MIN_PASSWORD}
              autoComplete="new-password"
              value={form.password}
              onChange={(event) =>
                setForm({ ...form, password: event.target.value })
              }
            />
            <p className="muted tiny" style={{ marginTop: 4 }}>
              {tooShort
                ? `Use at least ${MIN_PASSWORD} characters.`
                : `At least ${MIN_PASSWORD} characters.`}
            </p>
          </div>
          {error ? <div className="error-card">{error}</div> : null}
          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? "Creating the account…" : "Create account"}
          </button>
          <p className="muted small" style={{ marginTop: 12 }}>
            Already have an account? <Link href="/account/login">Sign in</Link>.
            Anything in your cart moves with you.
          </p>
        </form>
      </div>
    </main>
  );
}
