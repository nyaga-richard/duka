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
  { id: 1, label: "Nairobi standard delivery — KES 300" },
  { id: 2, label: "Countrywide courier — KES 500" },
  { id: 3, label: "Pickup at store — free" },
];

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

  const refresh = useCallback(async () => {
    try {
      const identity = await loadIdentity();
      if (identity?.kind === "customer" && identity.customer?.email) {
        setForm((current) => (current.email ? current : { ...current, email: identity.customer.email }));
      }
      const view = await api<CartView>("/cart");
      setCart(view);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not load your cart");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function setQuantity(variantId: number, quantity: number) {
    setError(null);
    try {
      const view = await api<CartView>(`/cart/items/${variantId}`, { method: "PATCH", body: { quantity } });
      setCart(view);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not update the cart");
    }
  }

  async function clearCart() {
    setError(null);
    try {
      setCart(await api<CartView>("/cart/clear", { method: "POST" }));
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
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not place the order");
    } finally {
      setPlacing(false);
    }
  }

  if (placed) {
    return (
      <main>
        <h1>Order {placed.order.order_number} placed</h1>
        <div className="notice ok">
          {placed.payment?.instructions ?? "Your order is saved. Payment is confirmed by the store team."}
        </div>
        <div className="card" style={{ padding: "1.1rem" }}>
          <div className="totals">
            <span>Status</span>
            <span className="pill">{placed.order.status}</span>
          </div>
          <div className="totals">
            <span>Total</span>
            <span className="price">KES {Number(placed.order.total).toLocaleString("en-KE")}</span>
          </div>
        </div>
        <div className="toolbar">
          <Link className="button" href={`/orders/${placed.order.order_id}`}>
            View order
          </Link>
          <Link className="button secondary" href="/">
            Keep shopping
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Your cart</h1>
      {error ? <div className="notice error">{error}</div> : null}
      {!cart ? (
        <p className="muted">Loading…</p>
      ) : cart.items.length === 0 ? (
        <div className="notice info">
          Your cart is empty. <Link href="/">Browse the shop</Link>.
        </div>
      ) : (
        <div className="split">
          <div>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Price</th>
                  <th>Qty</th>
                  <th>Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cart.items.map((item) => (
                  <tr key={item.variant_id}>
                    <td>
                      <strong>{item.name}</strong>
                      <div className="muted">
                        {item.options?.map((option) => option.value).join(" / ") || item.sku}
                      </div>
                    </td>
                    <td className="price">KES {Number(item.unit_price).toLocaleString("en-KE")}</td>
                    <td>
                      <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                        <button className="secondary" onClick={() => setQuantity(item.variant_id, Math.max(0, item.quantity - 1))}>
                          −
                        </button>
                        <span>{item.quantity}</span>
                        <button
                          className="secondary"
                          disabled={item.quantity >= item.available}
                          onClick={() => setQuantity(item.variant_id, item.quantity + 1)}
                        >
                          +
                        </button>
                      </div>
                    </td>
                    <td className="price">KES {Number(item.line_total).toLocaleString("en-KE")}</td>
                    <td>
                      <button className="secondary" onClick={() => setQuantity(item.variant_id, 0)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="toolbar">
              <button className="secondary" onClick={clearCart}>
                Empty cart
              </button>
              {cart.reservation_expires_at ? (
                <span className="muted">Stock is held until {new Date(cart.reservation_expires_at).toLocaleTimeString()}</span>
              ) : null}
            </div>
          </div>

          <form className="card" style={{ padding: "1.1rem" }} onSubmit={placeOrder}>
            <h3 style={{ marginTop: 0 }}>Checkout</h3>
            <div className="field">
              <label htmlFor="email">Email for the receipt</label>
              <input id="email" type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="name">Full name</label>
              <input id="name" required value={form.ship_name} onChange={(event) => setForm({ ...form, ship_name: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="address">Delivery address</label>
              <input id="address" required value={form.ship_address_line1} onChange={(event) => setForm({ ...form, ship_address_line1: event.target.value })} />
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="city">City</label>
                <input id="city" required value={form.ship_city} onChange={(event) => setForm({ ...form, ship_city: event.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="phone">Phone (optional)</label>
                <input id="phone" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="shipping">Delivery method</label>
              <select id="shipping" value={shippingMethodId} onChange={(event) => setShippingMethodId(Number(event.target.value))}>
                {SHIPPING.map((method) => (
                  <option key={method.id} value={method.id}>
                    {method.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="totals">
              <span>Subtotal</span>
              <span className="price">KES {Number(cart.subtotal).toLocaleString("en-KE")}</span>
            </div>
            <div className="totals grand">
              <span>Total (with delivery)</span>
              <span className="price">
                KES {(Number(cart.subtotal) + (shippingMethodId === 1 ? 300 : shippingMethodId === 2 ? 500 : 0)).toLocaleString("en-KE")}
              </span>
            </div>
            <p className="muted">Payment is collected on delivery or by bank transfer and confirmed by our team.</p>
            <button type="submit" disabled={placing} style={{ width: "100%" }}>
              {placing ? "Placing order…" : "Place order"}
            </button>
          </form>
        </div>
      )}
    </main>
  );
}
