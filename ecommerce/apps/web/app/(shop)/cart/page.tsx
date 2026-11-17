"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  BagIcon,
  CheckIcon,
  ChevronRightIcon,
  TruckIcon,
} from "@/components/icons";
import {
  api,
  ApiError,
  loadIdentity,
  newIdempotencyKey,
} from "@/lib/api-client";
import { HoldTimer } from "@/components/HoldTimer";

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

interface ShippingMethod {
  shipping_method_id: number;
  method_name: string;
  price: string;
  code: string;
  min_days: number;
  max_days: number;
}

/**
 * Shown until `GET /catalog/shipping-methods` answers, so the checkout form is
 * never empty. The API re-reads the fee from the same table when the order is
 * placed, so a stale label can misprice the preview but never the order.
 */
const FALLBACK_METHODS: ShippingMethod[] = [
  {
    shipping_method_id: 1,
    method_name: "Nairobi standard delivery",
    price: "300.00",
    code: "nairobi-standard",
    min_days: 1,
    max_days: 2,
  },
  {
    shipping_method_id: 2,
    method_name: "Countrywide courier",
    price: "500.00",
    code: "countrywide",
    min_days: 2,
    max_days: 5,
  },
  {
    shipping_method_id: 3,
    method_name: "Pickup at store",
    price: "0.00",
    code: "pickup",
    min_days: 0,
    max_days: 0,
  },
];

function estimate(method: ShippingMethod) {
  if (method.code === "pickup") return "Ready for collection at the store";
  if (method.max_days === 0) return "Same day";
  if (method.min_days === method.max_days)
    return `${method.max_days} day${method.max_days === 1 ? "" : "s"}`;
  return `${method.min_days}–${method.max_days} days`;
}

const money = (value: string | number) =>
  `KES ${Number(value).toLocaleString("en-KE")}`;

function monogram(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

const ADDRESS_KEY = "duka:last-address";

interface SavedAddress {
  ship_name: string;
  ship_address_line1: string;
  ship_city: string;
  ship_region: string;
  phone: string;
}

export default function CartPage() {
  const [cart, setCart] = useState<CartView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<{ order: any; payment: any } | null>(
    null,
  );
  const [identityKind, setIdentityKind] = useState<"customer" | "guest" | null>(
    null,
  );
  const [saved, setSaved] = useState<SavedAddress | null>(null);
  const [prefilled, setPrefilled] = useState(false);
  const [methods, setMethods] = useState<ShippingMethod[]>(FALLBACK_METHODS);
  const [shippingMethodId, setShippingMethodId] = useState(1);
  const [methodsLoaded, setMethodsLoaded] = useState(false);
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
      setIdentityKind(
        identity?.kind === "customer"
          ? "customer"
          : identity?.kind === "guest"
            ? "guest"
            : null,
      );
      if (identity?.kind === "customer" && identity.customer?.email) {
        setForm((current) =>
          current.email
            ? current
            : { ...current, email: identity.customer.email },
        );
      }
      const view = await api<CartView>("/cart");
      setCart(view);
      announce();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not load your cart",
      );
      setCart({ items: [], item_count: 0, subtotal: "0.00" });
    }
  }, [announce]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The last address typed on this device is offered again instead of asking
  // people to retype a delivery address they used a week ago. It stays on the
  // device: the API holds no "saved addresses" record.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(ADDRESS_KEY);
      if (!raw) return;
      const address = JSON.parse(raw) as SavedAddress;
      if (!address?.ship_name || !address?.ship_address_line1) return;
      setSaved(address);
      setForm((current) =>
        current.ship_name || current.ship_address_line1
          ? current
          : {
              ...current,
              ship_name: address.ship_name,
              ship_address_line1: address.ship_address_line1,
              ship_city: address.ship_city || current.ship_city,
              ship_region: address.ship_region || current.ship_region,
              phone: address.phone ?? current.phone,
            },
      );
      setPrefilled(true);
    } catch {
      // Ignore unreadable storage; the form just starts empty.
    }
  }, []);

  // Delivery options come from the store's own configuration, not from a copy
  // baked into this page.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const result = await api<{ items: ShippingMethod[] }>(
          "/catalog/shipping-methods",
        );
        if (!live || !result.items?.length) return;
        setMethods(result.items);
        setShippingMethodId((current) =>
          result.items.some((method) => method.shipping_method_id === current)
            ? current
            : result.items[0]!.shipping_method_id,
        );
      } catch {
        // Keep the fallback list; the order is priced server-side anyway.
      } finally {
        if (live) setMethodsLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function setQuantity(variantId: number, quantity: number) {
    setError(null);
    try {
      const view = await api<CartView>(`/cart/items/${variantId}`, {
        method: "PATCH",
        body: { quantity },
      });
      setCart(view);
      announce();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not update the cart",
      );
    }
  }

  async function clearCart() {
    setError(null);
    try {
      setCart(await api<CartView>("/cart/clear", { method: "POST" }));
      announce();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not clear the cart",
      );
    }
  }

  function forgetAddress() {
    window.localStorage.removeItem(ADDRESS_KEY);
    setSaved(null);
    setPrefilled(false);
    setForm((current) => ({
      ...current,
      ship_name: "",
      ship_address_line1: "",
      phone: "",
    }));
  }

  async function placeOrder(event: React.FormEvent) {
    event.preventDefault();
    setPlacing(true);
    setError(null);
    try {
      try {
        window.localStorage.setItem(
          ADDRESS_KEY,
          JSON.stringify({
            ship_name: form.ship_name,
            ship_address_line1: form.ship_address_line1,
            ship_city: form.ship_city,
            ship_region: form.ship_region,
            phone: form.phone,
          }),
        );
      } catch {
        // Private browsing can refuse storage; the order still goes through.
      }
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
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not place the order",
      );
    } finally {
      setPlacing(false);
    }
  }

  if (placed) {
    return (
      <main style={{ maxWidth: 620, margin: "0 auto" }}>
        <div className="card">
          <div className="success-panel" style={{ padding: "34px 26px" }}>
            <span className="success-mark" aria-hidden="true">
              <CheckIcon size={22} />
            </span>
            <h3>Order {placed.order.order_number} placed</h3>
            <p>
              {placed.payment?.instructions ??
                "Your order is saved. Payment is confirmed by the store team."}
            </p>
            <div
              className="cart-grand-total"
              style={{ maxWidth: 320, margin: "0 auto 18px" }}
            >
              <span>Total</span>
              <strong>{money(placed.order.total)}</strong>
            </div>
            <p className="muted small">
              Keep the number <strong>{placed.order.order_number}</strong> — you
              can find this order again under Orders with the email you used.
            </p>
            {identityKind !== "customer" ? (
              <p className="muted small">
                <Link href="/account/register">Create an account</Link> to keep
                your orders in one place, or{" "}
                <Link href="/orders">look this one up</Link> any time.
              </p>
            ) : null}
            <div className="row" style={{ justifyContent: "center" }}>
              <Link
                className="btn primary"
                href={`/orders/${placed.order.order_id}`}
              >
                View order
              </Link>
              <Link className="btn secondary" href="/shop">
                Keep shopping
              </Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  const subtotal = Number(cart?.subtotal ?? 0);
  const method =
    methods.find((entry) => entry.shipping_method_id === shippingMethodId) ??
    methods[0];
  const shippingFee = Number(method?.price ?? 0);
  const total = subtotal + shippingFee;

  // Stock can move between adding to the cart and checking out, so the lines
  // are checked again here rather than trusted from the add-to-cart response.
  const shortLines = (cart?.items ?? []).filter(
    (item) => item.available < item.quantity,
  );
  const stockBlocked = shortLines.length > 0;

  return (
    <main>
      <nav
        className="breadcrumbs"
        aria-label="Breadcrumb"
        style={{ marginBottom: 14 }}
      >
        <Link href="/shop">Shop</Link>
        <ChevronRightIcon size={12} />
        <strong>Cart</strong>
      </nav>

      <div className="page-heading">
        <div>
          <span className="eyebrow">Checkout</span>
          <h1>Your cart</h1>
          <p>
            Stock is held while you check out. Payment is confirmed by the store
            team after you place the order.
          </p>
        </div>
        {cart && cart.items.length > 0 ? (
          <span className="badge accent">
            {cart.item_count} item{cart.item_count === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {error ? <div className="error-card">{error}</div> : null}

      {!cart ? (
        <div className="split">
          <div className="card">
            <div className="card-content" style={{ paddingTop: 18 }}>
              <div
                className="skeleton"
                style={{ width: "40%", marginBottom: 14 }}
              />
              <div
                className="skeleton"
                style={{ width: "75%", marginBottom: 8 }}
              />
              <div className="skeleton" style={{ width: "60%" }} />
            </div>
          </div>
          <div className="card">
            <div className="card-content" style={{ paddingTop: 18 }}>
              <div
                className="skeleton"
                style={{ width: "50%", marginBottom: 12 }}
              />
              <div className="skeleton tall" style={{ height: "6rem" }} />
            </div>
          </div>
        </div>
      ) : cart.items.length === 0 ? (
        <div className="card">
          <div className="empty">
            <BagIcon size={26} />
            <h2>Your cart is empty</h2>
            <p>
              Everything you add is held for 15 minutes while you check out.
            </p>
            <Link className="btn primary sm" href="/shop">
              Browse the shop
            </Link>
          </div>
        </div>
      ) : (
        <div className="split">
          <div className="stack">
            <div className="card">
              <div className="card-heading">
                <div>
                  <h3>Items</h3>
                  <p>
                    {cart.item_count} item{cart.item_count === 1 ? "" : "s"} ·
                    held for 15 minutes
                  </p>
                </div>
                <button
                  className="btn ghost sm"
                  type="button"
                  onClick={clearCart}
                >
                  Empty cart
                </button>
              </div>
              <div className="card-content">
                <div className="cart-lines">
                  {cart.items.map((item) => (
                    <div className="cart-line" key={item.variant_id}>
                      <span className="product-avatar sm" aria-hidden="true">
                        {monogram(item.name)}
                      </span>
                      <div className="cart-line-info">
                        <strong>{item.name}</strong>
                        <div className="muted tiny">
                          {item.options
                            ?.map((option) => option.value)
                            .join(" / ") || item.sku}{" "}
                          · {money(item.unit_price)} each
                        </div>
                        {item.available <= 0 ? (
                          <div
                            className="tiny"
                            style={{ color: "var(--danger)", marginTop: 3 }}
                          >
                            Sold out — remove this line to continue
                          </div>
                        ) : item.available < item.quantity ? (
                          <div
                            className="tiny"
                            style={{ color: "var(--danger)", marginTop: 3 }}
                          >
                            Only {item.available} left — reduce the quantity
                          </div>
                        ) : item.available <= 2 ? (
                          <div
                            className="tiny"
                            style={{ color: "var(--warning)", marginTop: 3 }}
                          >
                            Only {item.available} left
                          </div>
                        ) : null}
                        <div className="quantity-stepper">
                          <button
                            type="button"
                            aria-label={`Decrease quantity of ${item.name}`}
                            onClick={() =>
                              setQuantity(
                                item.variant_id,
                                Math.max(0, item.quantity - 1),
                              )
                            }
                          >
                            −
                          </button>
                          <span>{item.quantity}</span>
                          <button
                            type="button"
                            aria-label={`Increase quantity of ${item.name}`}
                            disabled={item.quantity >= item.available}
                            onClick={() =>
                              setQuantity(item.variant_id, item.quantity + 1)
                            }
                          >
                            +
                          </button>
                        </div>
                      </div>
                      <div className="cart-line-end">
                        <span className="price small">
                          {money(item.line_total)}
                        </span>
                        <button
                          type="button"
                          className="btn ghost sm"
                          aria-label={`Remove ${item.name}`}
                          onClick={() => setQuantity(item.variant_id, 0)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                {cart.reservation_expires_at ? (
                  <HoldTimer
                    expiresAt={cart.reservation_expires_at}
                    onExpired={() => void refresh()}
                  />
                ) : null}
              </div>
            </div>

            <div className="card">
              <div className="card-content" style={{ paddingTop: 16 }}>
                <div className="stat-tile">
                  <span className="stat-icon" aria-hidden="true">
                    <TruckIcon size={16} />
                  </span>
                  <div>
                    <span className="stat-label">
                      Delivery{method ? ` · ${money(shippingFee)}` : ""}
                    </span>
                    <span className="stat-sub">
                      {method
                        ? `${method.method_name} · ${estimate(method)}. You can change this at checkout.`
                        : "Choose a delivery option at checkout."}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <form className="card sticky" onSubmit={placeOrder}>
            <div className="card-heading">
              <div>
                <h3>Checkout</h3>
                <p>We only need a delivery address to place the order.</p>
              </div>
              {prefilled && saved ? (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={forgetAddress}
                >
                  Clear saved address
                </button>
              ) : null}
            </div>
            <div className="card-content">
              <div className="field">
                <label htmlFor="email">Email for the receipt</label>
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
                <label htmlFor="name">Full name</label>
                <input
                  id="name"
                  required
                  autoComplete="name"
                  value={form.ship_name}
                  onChange={(event) =>
                    setForm({ ...form, ship_name: event.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="address">Delivery address</label>
                <input
                  id="address"
                  required
                  autoComplete="address-line1"
                  value={form.ship_address_line1}
                  onChange={(event) =>
                    setForm({ ...form, ship_address_line1: event.target.value })
                  }
                />
              </div>
              <div className="row" style={{ gap: 12 }}>
                <div className="field">
                  <label htmlFor="city">City</label>
                  <input
                    id="city"
                    required
                    autoComplete="address-level2"
                    value={form.ship_city}
                    onChange={(event) =>
                      setForm({ ...form, ship_city: event.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="phone">Phone (optional)</label>
                  <input
                    id="phone"
                    autoComplete="tel"
                    value={form.phone}
                    onChange={(event) =>
                      setForm({ ...form, phone: event.target.value })
                    }
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="shipping">Delivery method</label>
                <select
                  id="shipping"
                  value={shippingMethodId}
                  onChange={(event) =>
                    setShippingMethodId(Number(event.target.value))
                  }
                >
                  {methods.map((option) => (
                    <option
                      key={option.shipping_method_id}
                      value={option.shipping_method_id}
                    >
                      {option.method_name} —{" "}
                      {Number(option.price) === 0
                        ? "free"
                        : money(option.price)}{" "}
                      · {estimate(option)}
                    </option>
                  ))}
                </select>
                {!methodsLoaded ? (
                  <p className="muted tiny" style={{ marginTop: 4 }}>
                    Refreshing delivery options…
                  </p>
                ) : method ? (
                  <p className="muted tiny" style={{ marginTop: 4 }}>
                    {estimate(method)}
                  </p>
                ) : null}
              </div>

              {stockBlocked ? (
                <div className="error-card" style={{ marginBottom: 12 }}>
                  <div>
                    <strong>Stock changed while you were shopping.</strong>
                    <br />
                    {shortLines
                      .map(
                        (item) =>
                          `${item.name} — ${item.available} available of ${item.quantity}`,
                      )
                      .join("; ")}
                    . Adjust the quantities above to place this order.
                  </div>
                </div>
              ) : null}

              <hr className="separator" />

              <div className="totals">
                <span>Subtotal</span>
                <span className="price">{money(subtotal)}</span>
              </div>
              <div className="totals">
                <span>Delivery</span>
                <span className="price">
                  {shippingFee ? money(shippingFee) : "Free"}
                </span>
              </div>
              <div className="cart-grand-total">
                <span>Total</span>
                <strong>{money(total)}</strong>
              </div>

              {identityKind !== "customer" ? (
                <p className="muted tiny" style={{ marginBottom: 10 }}>
                  Checking out as a guest.{" "}
                  <Link href="/account/login?next=/cart">Sign in</Link> or{" "}
                  <Link href="/account/register">create an account</Link> and
                  this cart comes with you.
                </p>
              ) : null}
              <p className="muted tiny" style={{ marginBottom: 12 }}>
                Payment is collected on delivery or by bank transfer and
                confirmed by our team.
              </p>
              <button
                type="submit"
                className="btn primary lg block"
                disabled={placing || stockBlocked}
              >
                {placing
                  ? "Placing order…"
                  : stockBlocked
                    ? "Adjust quantities to continue"
                    : "Place order"}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
