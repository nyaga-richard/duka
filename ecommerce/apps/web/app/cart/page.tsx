"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, loadIdentity, newIdempotencyKey } from "@/lib/api-client";

interface CartLine {
  variant_id: number;
  name: string;
  sku: string;
  quantity: number;
  unit_price: string;
  line_total: string;
  available: number;
  options?: Array<{ option: string; value: string }>;
}
interface CartView {
  cart_id?: string;
  items: CartLine[];
  item_count: number;
  subtotal: string;
  reservation_expires_at?: string | null;
}

const SHIPPING = [
  { id: 1, label: "Nairobi standard delivery — KES 300", fee: 300 },
  { id: 2, label: "Countrywide courier — KES 500", fee: 500 },
  { id: 3, label: "Pickup at store — free", fee: 0 },
];

const money = (value: string | number) => `KES ${Number(value).toLocaleString("en-KE")}`;

export default function CartPage() {
  const [cart, setCart] = useState<CartView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<{ order: any; payment: any } | null>(null);
  const [shippingMethodId, setShippingMethodId] = useState(1);
  const [form, setForm] = useState({
    email: "",
    ship_name: "",
    ship_address_line1: "",
    ship_city: "Nairobi",
    ship_region: "Nairobi County",
    phone: "",
  });

  const announce = useCallback(() => {
    window.dispatchEvent(new Event("cart:updated"));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const identity = await loadIdentity();
      if (identity?.kind === "customer" && identity.customer?.email) {
        setForm((current) => (current.email ? current : { ...current, email: identity.customer.email }));
      }
      const view = await api<CartView>("/cart");
      setCart(view);
      announce();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not load your cart");
      setCart({ items: [], item_count: 0, subtotal: "0.00" });
    }
  }, [announce]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function setQuantity(variantId: number, quantity: number) {
    setError(null);
    try {
      const view = await api<CartView>(`/cart/items/${variantId}`, { method: "PATCH", body: { quantity } });
      setCart(view);
      announce();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not update the cart");
    }
  }

  async function clearCart() {
    setError(null);
    try {
      setCart(await api<CartView>("/cart/clear", { method: "POST" }));
      announce();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not clear the cart");
    }
  }

  async function placeOrder(event: React.FormEvent) {
    event.preventDefault();
    setPlacing(true);
    setError(null);
    try {
      const result = await api<{ order: any; payment: any }>("/orders", {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        body: {
          shipping_method_id: shippingMethodId,
          ship_name: form.ship_name,
          ship_address_line1: form.ship_address_line1,
          ship_city: form.ship_city,
          ship_region: form.ship_region,
          ship_country: "Kenya",
          phone: form.phone || undefined,
          email: form.email || undefined,
        },
      });
      setPlaced(result);
      setCart({ items: [], item_count: 0, subtotal: "0.00" });
      announce();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not place the order");
    } finally {
      setPlacing(false);
    }
  }

  if (placed) {
    return (
      <main className="narrow">
        <div className="panel" style={{ textAlign: "center" }}>
          <div
            className="avatar"
            aria-hidden="true"
            style={{ width: 48, height: 48, margin: "0 auto 0.75rem", fontSize: "1.2rem" }}
          >
            ✓
          </div>
          <h1 style={{ fontSize: "1.5rem" }}>Order {placed.order.order_number} placed</h1>
          <p className="lede" style={{ margin: "0 auto 1rem" }}>
            {placed.payment?.instructions ?? "Your order is saved. Payment is confirmed by the store team."}
          </p>
          <div className="totals">
            <span>Status</span>
            <span className="badge accent">{placed.order.status}</span>
          </div>
          <div className="totals grand">
            <span>Total</span>
            <span className="price">{money(placed.order.total)}</span>
          </div>
          <div className="toolbar" style={{ justifyContent: "center" }}>
            <Link className="button" href={`/orders/${placed.order.order_id}`}>
              View order
            </Link>
            <Link className="button secondary" href="/">
              Keep shopping
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const subtotal = Number(cart?.subtotal ?? 0);
  const shippingFee = SHIPPING.find((method) => method.id === shippingMethodId)?.fee ?? 0;
  const total = subtotal + shippingFee;

  return (
    <main>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Your cart</h1>
        <span className="grow" />
        {cart && cart.items.length > 0 ? (
          <span className="small muted">
            {cart.item_count} item{cart.item_count === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      {!cart ? (
        <div className="split">
          <div className="panel">
            <div className="skeleton line" style={{ width: "40%", marginBottom: "1rem" }} />
            <div className="skeleton line" style={{ width: "75%", marginBottom: "0.6rem" }} />
            <div className="skeleton line" style={{ width: "60%" }} />
          </div>
          <div className="panel">
            <div className="skeleton line" style={{ width: "50%", marginBottom: "0.8rem" }} />
            <div className="skeleton" style={{ height: "6rem" }} />
          </div>
        </div>
      ) : cart.items.length === 0 ? (
        <div className="empty">
          <h2>Your cart is empty</h2>
          <p>Everything you add is held for 15 minutes while you check out.</p>
          <Link className="button" href="/">
            Browse the shop
          </Link>
        </div>
      ) : (
        <div className="split">
          <div className="panel">
            {cart.items.map((item) => (
              <div className="cart-line" key={item.variant_id}>
                <div className="thumb" aria-hidden="true">
                  {item.name
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((word) => word[0]?.toUpperCase() ?? "")
                    .join("")}
                </div>
                <div>
                  <strong style={{ fontSize: "0.96rem" }}>{item.name}</strong>
                  <div className="small muted">
                    {item.options?.map((option) => option.value).join(" / ") || item.sku} · {money(item.unit_price)} each
                  </div>
                  {item.available <= item.quantity ? (
                    <div className="small" style={{ color: "var(--warn)", marginTop: "0.2rem" }}>
                      Only {item.available} in stock
                    </div>
                  ) : null}
                </div>
                <div className="actions" style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                  <div className="stepper">
                    <button
                      type="button"
                      aria-label={`Decrease quantity of ${item.name}`}
                      onClick={() => setQuantity(item.variant_id, Math.max(0, item.quantity - 1))}
                    >
                      −
                    </button>
                    <span>{item.quantity}</span>
                    <button
                      type="button"
                      aria-label={`Increase quantity of ${item.name}`}
                      disabled={item.quantity >= item.available}
                      onClick={() => setQuantity(item.variant_id, item.quantity + 1)}
                    >
                      +
                    </button>
                  </div>
                  <span className="price" style={{ minWidth: "5.5rem", textAlign: "right" }}>
                    {money(item.line_total)}
                  </span>
                  <button
                    type="button"
                    className="quiet"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => setQuantity(item.variant_id, 0)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}

            <div className="toolbar" style={{ marginBottom: 0 }}>
              <button className="secondary" type="button" onClick={clearCart}>
                Empty cart
              </button>
              {cart.reservation_expires_at ? (
                <span className="small muted">
                  Stock is held until {new Date(cart.reservation_expires_at).toLocaleTimeString()}
                </span>
              ) : null}
            </div>
          </div>

          <form className="panel sticky" onSubmit={placeOrder}>
            <h3>Checkout</h3>

            <div className="field">
              <label htmlFor="email">Email for the receipt</label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="name">Full name</label>
              <input
                id="name"
                required
                autoComplete="name"
                value={form.ship_name}
                onChange={(event) => setForm({ ...form, ship_name: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="address">Delivery address</label>
              <input
                id="address"
                required
                autoComplete="address-line1"
                value={form.ship_address_line1}
                onChange={(event) => setForm({ ...form, ship_address_line1: event.target.value })}
              />
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="city">City</label>
                <input
                  id="city"
                  required
                  autoComplete="address-level2"
                  value={form.ship_city}
                  onChange={(event) => setForm({ ...form, ship_city: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="phone">Phone (optional)</label>
                <input
                  id="phone"
                  autoComplete="tel"
                  value={form.phone}
                  onChange={(event) => setForm({ ...form, phone: event.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="shipping">Delivery method</label>
              <select
                id="shipping"
                value={shippingMethodId}
                onChange={(event) => setShippingMethodId(Number(event.target.value))}
              >
                {SHIPPING.map((method) => (
                  <option key={method.id} value={method.id}>
                    {method.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="totals">
              <span>Subtotal</span>
              <span className="price">{money(subtotal)}</span>
            </div>
            <div className="totals">
              <span>Delivery</span>
              <span className="price">{shippingFee ? money(shippingFee) : "Free"}</span>
            </div>
            <div className="totals grand">
              <span>Total</span>
              <span className="price">{money(total)}</span>
            </div>

            <p className="small muted" style={{ marginTop: "0.6rem" }}>
              Payment is collected on delivery or by bank transfer and confirmed by our team.
            </p>
            <button type="submit" className="block" disabled={placing}>
              {placing ? "Placing order…" : "Place order"}
            </button>
          </form>
        </div>
      )}
    </main>
  );
}
