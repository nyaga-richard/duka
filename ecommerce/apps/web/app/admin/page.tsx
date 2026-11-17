"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Brand } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  BoxesIcon,
  CheckIcon,
  ChevronRightIcon,
  HelpIcon,
  LogOutIcon,
  MenuIcon,
  ReceiptIcon,
  StoreIcon,
  SyncIcon,
} from "@/components/icons";
import { Overlay } from "@/components/ui/Overlay";
import { useToast } from "@/components/ui/Toast";
import {
  api,
  ApiError,
  loadIdentity,
  newIdempotencyKey,
} from "@/lib/api-client";

/* ------------------------------------------------------------------ types */

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
  payments: Array<{
    amount: string;
    payment_status: string;
    provider_reference: string;
  }>;
}

interface AdminProduct {
  product_id: number;
  product_name: string;
  slug: string;
  status: "draft" | "active" | "archived";
  sync_state: string | null;
  variants: number;
  erp_product_id: string | null;
  updated_at: string;
}

interface SyncLog {
  log_id: number;
  entity_type: string;
  direction: string;
  operation: string;
  status: string;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
}

interface SyncOverview {
  enabled: boolean;
  jobs: Record<string, number>;
  recent_logs: SyncLog[];
  settings: Record<string, string>;
  capabilities: Array<{
    id: string;
    support: string;
    endpoint?: string;
    contract?: string;
  }>;
}

type Tab = "orders" | "catalogue" | "sync";

/* -------------------------------------------------------------- utilities */

const money = (value: string | number) =>
  `KES ${Number(value).toLocaleString("en-KE")}`;

/** Mirrors ALLOWED_TRANSITIONS in the API, so the UI cannot offer a move the
 *  server will reject. Keep the two lists in step. */
const TRANSITIONS: Record<string, string[]> = {
  placed: ["paid", "payment_failed", "cancelled"],
  payment_failed: ["paid", "cancelled"],
  paid: ["processing", "shipped", "cancelled", "refunded"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered", "refunded"],
  delivered: ["refunded"],
  cancelled: [],
  refunded: [],
};

const CLOSED = new Set(["delivered", "cancelled", "refunded"]);

function tone(status: string): string {
  const value = status.toLowerCase();
  if (
    [
      "paid",
      "fulfilled",
      "delivered",
      "completed",
      "captured",
      "success",
      "succeeded",
      "active",
      "published",
      "verified",
      "supported",
    ].some((word) => value.includes(word))
  )
    return "ok";
  if (
    [
      "cancel",
      "refund",
      "fail",
      "void",
      "archived",
      "rejected",
      "error",
      "missing",
      "unsupported",
    ].some((word) => value.includes(word))
  )
    return "danger";
  if (
    [
      "pending",
      "await",
      "partial",
      "hold",
      "unpaid",
      "draft",
      "queued",
      "running",
      "retry",
    ].some((word) => value.includes(word))
  )
    return "warn";
  return "accent";
}

function Status({ value }: { value: string }) {
  return (
    <span className={`badge ${tone(value)}`}>
      {value.replace(/[_-]/g, " ")}
    </span>
  );
}

const TAB_META: Array<{
  id: Tab;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}> = [
  { id: "orders", label: "Orders", icon: ReceiptIcon },
  { id: "catalogue", label: "Catalogue", icon: BoxesIcon },
  { id: "sync", label: "ERP sync", icon: SyncIcon },
];

/* ------------------------------------------------------------------- page */

export default function AdminPage() {
  const { toast } = useToast();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState<Tab>("orders");
  const [error, setError] = useState<string | null>(null);

  // chrome
  const [mobileNav, setMobileNav] = useState(false);

  // orders
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selected, setSelected] = useState<OrderDetail | null>(null);
  const [payment, setPayment] = useState({ amount: "", reference: "" });
  const [refund, setRefund] = useState({ amount: "", reason: "" });
  const [transition, setTransition] = useState({ status: "", reason: "" });
  const [working, setWorking] = useState(false);

  // catalogue
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [productQuery, setProductQuery] = useState({ q: "", status: "" });
  const [productsLoading, setProductsLoading] = useState(false);

  // sync
  const [sync, setSync] = useState<SyncOverview | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);

  const loadOrders = useCallback(async () => {
    try {
      const data = await api<{ items: OrderRow[] }>("/admin/orders?limit=25");
      setOrders(data.items);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401)
        setSignedIn(false);
      else
        setError(
          caught instanceof ApiError ? caught.message : "Could not load orders",
        );
    }
  }, []);

  const loadProducts = useCallback(
    async (query: { q: string; status: string }) => {
      setProductsLoading(true);
      try {
        const search = new URLSearchParams({ limit: "25", page: "1" });
        if (query.q.trim()) search.set("q", query.q.trim());
        if (query.status) search.set("status", query.status);
        const data = await api<{ items: AdminProduct[] }>(
          `/admin/products?${search.toString()}`,
        );
        setProducts(data.items);
      } catch (caught) {
        setError(
          caught instanceof ApiError
            ? caught.message
            : "Could not load the catalogue",
        );
      } finally {
        setProductsLoading(false);
      }
    },
    [],
  );

  const loadSync = useCallback(async () => {
    setSyncLoading(true);
    try {
      setSync(await api<SyncOverview>("/admin/sync/overview"));
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.message
          : "Could not load the sync overview";
      setError(message);
    } finally {
      setSyncLoading(false);
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

  useEffect(() => {
    if (!signedIn) return;
    if (tab === "catalogue" && products.length === 0)
      void loadProducts(productQuery);
    if (tab === "sync" && !sync) void loadSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, signedIn]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api("/admin/auth/login", {
        method: "POST",
        body: { email, password },
      });
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
      setTransition({
        status: TRANSITIONS[detail.status]?.[0] ?? "",
        reason: "",
      });
      setDetailOpen(true);
    } catch (caught) {
      toast({
        title: "Could not open the order",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    }
  }

  async function recordPayment(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setWorking(true);
    try {
      await api(`/admin/orders/${selected.order_id}/payments`, {
        method: "POST",
        body: { amount: payment.amount, reference: payment.reference },
      });
      toast({
        title: "Payment recorded",
        description: `${selected.order_number} · ${money(payment.amount)}`,
      });
      await openOrder(selected.order_id);
      await loadOrders();
    } catch (caught) {
      toast({
        title: "Could not record the payment",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    } finally {
      setWorking(false);
    }
  }

  async function requestRefund(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setWorking(true);
    try {
      await api(`/admin/orders/${selected.order_id}/refunds`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        body: { amount: refund.amount, reason: refund.reason },
      });
      toast({
        title: "Refund requested",
        description: "Recorded and awaiting settlement.",
      });
      await openOrder(selected.order_id);
      await loadOrders();
    } catch (caught) {
      toast({
        title: "Could not request the refund",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    } finally {
      setWorking(false);
    }
  }

  async function moveOrder(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !transition.status) return;
    setWorking(true);
    try {
      await api(`/admin/orders/${selected.order_id}/status`, {
        method: "PATCH",
        body: { status: transition.status, reason: transition.reason },
      });
      toast({
        title: "Order moved",
        description: `${selected.order_number} → ${transition.status.replace(/_/g, " ")}`,
      });
      await openOrder(selected.order_id);
      await loadOrders();
    } catch (caught) {
      toast({
        title: "Could not move the order",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    } finally {
      setWorking(false);
    }
  }

  async function setProductStatus(
    product: AdminProduct,
    status: "draft" | "active" | "archived",
  ) {
    try {
      await api(`/admin/products/${product.product_id}/status`, {
        method: "PATCH",
        body: { status },
      });
      setProducts((current) =>
        current.map((row) =>
          row.product_id === product.product_id ? { ...row, status } : row,
        ),
      );
      toast({ title: `${product.product_name} → ${status}` });
    } catch (caught) {
      toast({
        title: "Could not change the product",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    }
  }

  function refresh() {
    if (!signedIn) return;
    void loadOrders();
    if (tab === "catalogue") void loadProducts(productQuery);
    if (tab === "sync") void loadSync();
  }

  /* ---------------------------------------------------------------- views */

  if (signedIn === null) {
    return (
      <div className="login-layout">
        <div className="login-form-panel">
          <div className="login-form-wrap">
            <div
              className="skeleton"
              style={{ width: "45%", marginBottom: 14 }}
            />
            <div className="skeleton tall" style={{ height: "5rem" }} />
          </div>
        </div>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="login-layout">
        <div className="login-story">
          <Brand onDark label="business os" />
          <span className="story-orbit" aria-hidden="true" />
          <div className="story-copy">
            <span className="eyebrow">Store desk</span>
            <h2>The shop side of your business, with the same books.</h2>
            <p>
              Orders arrive here from the storefront, stock and prices stay
              owned by the ERP, and every payment and refund is recorded against
              the order it belongs to.
            </p>
            <div className="story-list">
              <span>
                <CheckIcon size={14} /> Record a manual payment in two fields
              </span>
              <span>
                <CheckIcon size={14} /> Move fulfilment only where the order can
                go
              </span>
              <span>
                <CheckIcon size={14} /> Refunds carry an idempotency key and an
                audit trail
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
            <form onSubmit={signIn}>
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
              <button type="submit" className="btn primary lg block">
                Sign in
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

  const recorded = orders.reduce(
    (sum, order) => sum + Number(order.order_total || 0),
    0,
  );
  const awaiting = orders.filter(
    (order) => !/paid|captured|refund/i.test(order.payment_status),
  ).length;
  const open = orders.filter((order) => !CLOSED.has(order.status)).length;
  const currentTab = TAB_META.find((entry) => entry.id === tab)!;

  return (
    <div className="app-layout">
      {mobileNav ? (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      ) : null}

      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <Link href="/admin" className="brand-link" aria-label="Duka store desk">
          <Brand onDark label="store desk" />
        </Link>
        <div className="workspace-switch">
          <div className="workspace-mark">D</div>
          <div>
            <strong>Duka Shop</strong>
            <small>Storefront · KES</small>
          </div>
        </div>
        <nav aria-label="Store desk navigation">
          <div className="nav-group">Store</div>
          {TAB_META.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                className={`nav-item ${tab === entry.id ? "active" : ""}`}
                aria-current={tab === entry.id ? "page" : undefined}
                onClick={() => {
                  setTab(entry.id);
                  setMobileNav(false);
                }}
              >
                <Icon size={18} />
                <span>{entry.label}</span>
                {entry.id === "orders" && orders.length ? (
                  <span className="nav-key">{orders.length}</span>
                ) : null}
              </button>
            );
          })}
          <div className="nav-group">Shop</div>
          <Link className="nav-item" href="/">
            <StoreIcon size={18} />
            <span>View storefront</span>
          </Link>
          <Link className="nav-item" href="/cart">
            <ReceiptIcon size={18} />
            <span>My cart</span>
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <button className="support-link" type="button" onClick={refresh}>
            <HelpIcon size={17} />
            <span>Refresh this screen</span>
          </button>
          <button
            className="support-link"
            type="button"
            onClick={() => setSignedIn(false)}
          >
            <LogOutIcon size={17} />
            <span>Sign out</span>
          </button>
          <div className="sidebar-status">
            <span className="status-dot" />
            Store connected
            <span className="version">v0.1</span>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-btn mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <MenuIcon size={21} />
            </button>
            <div className="breadcrumbs">
              <span>Store desk</span>
              <ChevronRightIcon size={12} />
              <strong>{currentTab.label}</strong>
            </div>
          </div>
          <div className="topbar-right">
            <button
              className="btn secondary sm"
              type="button"
              onClick={refresh}
            >
              Refresh
            </button>
            <ThemeToggle />
          </div>
        </header>

        <main className="page-content">
          <div className="page-heading">
            <div>
              <h1>Store desk</h1>
              <p>Payments, fulfilment and what the storefront is publishing.</p>
            </div>
            <div className="heading-actions">
              <span className="badge outline">
                <span className="status-dot" />
                {orders.length} orders loaded
              </span>
            </div>
          </div>

          {error ? <div className="error-card">{error}</div> : null}

          <div
            className="page-tabs"
            role="tablist"
            aria-label="Store desk sections"
          >
            {TAB_META.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`tab-${entry.id}`}
                aria-selected={tab === entry.id}
                aria-controls={`panel-${entry.id}`}
                className={tab === entry.id ? "active" : undefined}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
                {entry.id === "orders" && orders.length ? (
                  <span className="count">{orders.length}</span>
                ) : null}
                {entry.id === "catalogue" && products.length ? (
                  <span className="count">{products.length}</span>
                ) : null}
              </button>
            ))}
          </div>

          {/* -------------------------------------------------- orders tab */}
          {tab === "orders" ? (
            <section
              role="tabpanel"
              id="panel-orders"
              aria-labelledby="tab-orders"
            >
              <div className="stat-grid">
                <div className="stat-card">
                  <div className="stat-top">
                    <span>Orders loaded</span>
                    <ReceiptIcon size={15} />
                  </div>
                  <strong>{orders.length}</strong>
                  <div className="stat-bottom">
                    <span>{open} still open</span>
                    <span>last 25</span>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-top">
                    <span>Recorded value</span>
                  </div>
                  <strong>{money(recorded)}</strong>
                  <div className="stat-bottom">
                    <span>On the orders above</span>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-top">
                    <span>Awaiting payment</span>
                  </div>
                  <strong>{awaiting}</strong>
                  <div className="stat-bottom">
                    <span>
                      {awaiting
                        ? "Record a manual payment"
                        : "Nothing outstanding"}
                    </span>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-top">
                    <span>Fulfilment</span>
                  </div>
                  <strong>{orders.length - open}</strong>
                  <div className="stat-bottom">
                    <span>delivered, cancelled or refunded</span>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="table-toolbar">
                  <h2 style={{ fontSize: 14 }}>Recent orders</h2>
                  <span className="muted small">
                    Newest first · open an order to record money or move it
                  </span>
                </div>
                <div className="table-scroll">
                  <table className="data-table">
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
                          <td colSpan={5} className="empty-cell">
                            No orders yet. Orders placed on the storefront
                            appear here.
                          </td>
                        </tr>
                      ) : (
                        orders.map((order) => (
                          <tr key={order.order_id}>
                            <td>
                              <strong>{order.order_number}</strong>
                              <div className="muted tiny">
                                {order.email ?? "guest"} · {order.line_count}{" "}
                                line{order.line_count === 1 ? "" : "s"}
                              </div>
                            </td>
                            <td>
                              <Status value={order.status} />
                            </td>
                            <td>
                              <Status value={order.payment_status} />
                            </td>
                            <td className="num price">
                              {money(order.order_total)}
                            </td>
                            <td className="num">
                              <span className="row-actions">
                                <button
                                  className="btn outline sm"
                                  type="button"
                                  onClick={() => openOrder(order.order_id)}
                                >
                                  Open
                                </button>
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          ) : null}

          {/* ----------------------------------------------- catalogue tab */}
          {tab === "catalogue" ? (
            <section
              role="tabpanel"
              id="panel-catalogue"
              aria-labelledby="tab-catalogue"
            >
              <div className="card">
                <form
                  className="table-toolbar"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void loadProducts(productQuery);
                  }}
                >
                  <div className="search-box">
                    <input
                      type="search"
                      placeholder="Search the catalogue"
                      aria-label="Search the catalogue"
                      value={productQuery.q}
                      onChange={(event) =>
                        setProductQuery({
                          ...productQuery,
                          q: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="toolbar-filters">
                    <select
                      aria-label="Filter by status"
                      value={productQuery.status}
                      onChange={(event) => {
                        const next = {
                          ...productQuery,
                          status: event.target.value,
                        };
                        setProductQuery(next);
                        void loadProducts(next);
                      }}
                    >
                      <option value="">All statuses</option>
                      <option value="active">Published</option>
                      <option value="draft">Draft</option>
                      <option value="archived">Archived</option>
                    </select>
                    <button className="btn secondary sm" type="submit">
                      Search
                    </button>
                    <span className="muted small">
                      {productsLoading
                        ? "Loading…"
                        : `${products.length} shown`}
                    </span>
                  </div>
                </form>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Status</th>
                        <th>Sync</th>
                        <th className="num">Variants</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {products.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="empty-cell">
                            {productsLoading
                              ? "Loading the catalogue…"
                              : "No products match. Pull the catalogue from the ERP or create products locally."}
                          </td>
                        </tr>
                      ) : (
                        products.map((product) => (
                          <tr key={product.product_id}>
                            <td>
                              <strong>{product.product_name}</strong>
                              <div className="muted tiny">
                                /{product.slug}
                                {product.erp_product_id
                                  ? ` · ERP #${product.erp_product_id}`
                                  : " · local"}
                              </div>
                            </td>
                            <td>
                              <Status value={product.status} />
                            </td>
                            <td>
                              {product.sync_state ? (
                                <Status value={product.sync_state} />
                              ) : (
                                <span className="muted small">—</span>
                              )}
                            </td>
                            <td className="num">{product.variants}</td>
                            <td className="num">
                              <span className="row-actions">
                                {product.status !== "active" ? (
                                  <button
                                    className="btn primary sm"
                                    type="button"
                                    onClick={() =>
                                      setProductStatus(product, "active")
                                    }
                                  >
                                    Publish
                                  </button>
                                ) : (
                                  <button
                                    className="btn outline sm"
                                    type="button"
                                    onClick={() =>
                                      setProductStatus(product, "draft")
                                    }
                                  >
                                    Unpublish
                                  </button>
                                )}
                                {product.status !== "archived" ? (
                                  <button
                                    className="btn ghost sm"
                                    type="button"
                                    onClick={() =>
                                      setProductStatus(product, "archived")
                                    }
                                  >
                                    Archive
                                  </button>
                                ) : null}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="card-note">
                  Stock and prices stay owned by the ERP; this only controls
                  what the storefront publishes.
                </p>
              </div>
            </section>
          ) : null}

          {/* ---------------------------------------------------- sync tab */}
          {tab === "sync" ? (
            <section role="tabpanel" id="panel-sync" aria-labelledby="tab-sync">
              {syncLoading && !sync ? (
                <div className="stat-grid">
                  <div className="skeleton tall" style={{ height: "5rem" }} />
                  <div className="skeleton tall" style={{ height: "5rem" }} />
                  <div className="skeleton tall" style={{ height: "5rem" }} />
                  <div className="skeleton tall" style={{ height: "5rem" }} />
                </div>
              ) : sync ? (
                <>
                  <div className="card">
                    <div className="card-heading">
                      <div>
                        <h3>ERP integration</h3>
                        <p>
                          Jobs queued by the worker, and whether the adapter is
                          switched on.
                        </p>
                      </div>
                      {sync.enabled ? (
                        <span className="badge ok">enabled</span>
                      ) : (
                        <span className="badge warn">disabled</span>
                      )}
                    </div>
                    <div className="card-content">
                      <div className="stat-grid" style={{ marginBottom: 0 }}>
                        {["queued", "running", "failed", "succeeded"].map(
                          (state) => (
                            <div className="stat-card" key={state}>
                              <div className="stat-top">
                                <span>Jobs {state}</span>
                              </div>
                              <strong>{sync.jobs[state] ?? 0}</strong>
                              <div className="stat-bottom">
                                <span>
                                  {state === "failed"
                                    ? "retry from the ERP"
                                    : "sync queue"}
                                </span>
                              </div>
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="card">
                    <div className="card-heading">
                      <div>
                        <h3>Recent sync activity</h3>
                        <p>Newest 25 entries from the sync log.</p>
                      </div>
                    </div>
                    <div className="table-scroll">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Entity</th>
                            <th>Operation</th>
                            <th>Status</th>
                            <th className="num">Attempts</th>
                            <th>Started</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sync.recent_logs.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="empty-cell">
                                No sync activity yet.
                              </td>
                            </tr>
                          ) : (
                            sync.recent_logs.map((log) => (
                              <tr key={log.log_id}>
                                <td>
                                  {log.entity_type}
                                  <div className="muted tiny">
                                    {log.direction}
                                  </div>
                                </td>
                                <td>
                                  {log.operation}
                                  {log.error_code ? (
                                    <div className="muted tiny">
                                      {log.error_code}
                                    </div>
                                  ) : null}
                                </td>
                                <td>
                                  <Status value={log.status} />
                                </td>
                                <td className="num">{log.attempts}</td>
                                <td className="muted small">
                                  {log.started_at
                                    ? new Date(log.started_at).toLocaleString()
                                    : "—"}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="card">
                    <div className="card-heading">
                      <div>
                        <h3>ERP capabilities</h3>
                        <p>
                          What the adapter has verified against the ERP
                          endpoints.
                        </p>
                      </div>
                      <span className="badge">
                        {sync.capabilities.length} checked
                      </span>
                    </div>
                    <div className="card-content">
                      <div className="list">
                        {sync.capabilities.map((capability) => (
                          <div className="list-row" key={capability.id}>
                            <span className="mono" style={{ flex: 1 }}>
                              {capability.id}
                            </span>
                            {capability.endpoint ? (
                              <span className="muted tiny mono">
                                {capability.endpoint}
                              </span>
                            ) : null}
                            <Status value={capability.support} />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="card">
                  <div className="empty">
                    <h2>Sync overview unavailable</h2>
                    <p>Your admin role may not include the sync permission.</p>
                  </div>
                </div>
              )}
            </section>
          ) : null}
        </main>

        <footer className="app-footer">
          <span>Duka Business OS · store desk</span>
          <span>Prices and stock stay owned by the ERP</span>
        </footer>
      </div>

      {/* -------------------------------------------------- order dialog */}
      <Overlay
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={selected ? `Order ${selected.order_number}` : "Order"}
        description={
          selected
            ? "Record money, move fulfilment, keep the trail."
            : undefined
        }
        footer={
          selected ? (
            <div
              className="cart-grand-total"
              style={{ margin: 0, border: 0, padding: 0, width: "100%" }}
            >
              <span>Total</span>
              <strong>{money(selected.totals.total)}</strong>
            </div>
          ) : null
        }
      >
        {!selected ? (
          <div className="skeleton tall" style={{ height: "8rem" }} />
        ) : (
          <>
            <div className="row" style={{ marginBottom: 14 }}>
              <Status value={selected.status} />
              <Status value={selected.payment_status} />
            </div>

            <div className="detail-grid">
              <div>
                <span>Subtotal</span>
                <strong>{money(selected.totals.subtotal)}</strong>
              </div>
              <div>
                <span>Delivery</span>
                <strong>{money(selected.totals.shipping)}</strong>
              </div>
            </div>

            <div className="list" style={{ marginBottom: 6 }}>
              {selected.items.map((item, index) => (
                <div className="list-row" key={index}>
                  <span style={{ flex: 1 }}>
                    {item.quantity} × {item.product_name}
                  </span>
                  <span className="price small">{money(item.line_total)}</span>
                </div>
              ))}
            </div>

            {selected.payments.length ? (
              <p className="muted small" style={{ marginTop: 8 }}>
                Captured:{" "}
                {selected.payments
                  .map(
                    (entry) =>
                      `${entry.provider_reference} (${entry.payment_status})`,
                  )
                  .join(", ")}
              </p>
            ) : null}

            <hr className="separator" />

            <form onSubmit={moveOrder}>
              <h4 style={{ marginBottom: 12 }}>Move fulfilment</h4>
              {TRANSITIONS[selected.status]?.length ? (
                <>
                  <div className="row" style={{ gap: 12 }}>
                    <div className="field">
                      <label htmlFor="next-status">Next status</label>
                      <select
                        id="next-status"
                        value={transition.status}
                        onChange={(event) =>
                          setTransition({
                            ...transition,
                            status: event.target.value,
                          })
                        }
                      >
                        {TRANSITIONS[selected.status].map((status) => (
                          <option key={status} value={status}>
                            {status.replace(/_/g, " ")}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="next-reason">
                        Reason (min 5 characters)
                      </label>
                      <input
                        id="next-reason"
                        required
                        minLength={5}
                        value={transition.reason}
                        onChange={(event) =>
                          setTransition({
                            ...transition,
                            reason: event.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="form-actions">
                    <button
                      className="btn primary sm"
                      type="submit"
                      disabled={working || !transition.status}
                    >
                      Move order
                    </button>
                  </div>
                </>
              ) : (
                <p className="muted small">
                  {selected.status} is terminal — no further transitions.
                </p>
              )}
            </form>

            <hr className="separator" />

            <form onSubmit={recordPayment}>
              <h4 style={{ marginBottom: 12 }}>Record a manual payment</h4>
              <div className="row" style={{ gap: 12 }}>
                <div className="field">
                  <label htmlFor="amount">Amount (KES)</label>
                  <input
                    id="amount"
                    required
                    inputMode="decimal"
                    value={payment.amount}
                    onChange={(event) =>
                      setPayment({ ...payment, amount: event.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="reference">Reference</label>
                  <input
                    id="reference"
                    required
                    value={payment.reference}
                    onChange={(event) =>
                      setPayment({ ...payment, reference: event.target.value })
                    }
                  />
                </div>
              </div>
              <div className="form-actions">
                <button
                  className="btn secondary sm"
                  type="submit"
                  disabled={working}
                >
                  Record payment
                </button>
              </div>
            </form>

            <hr className="separator" />

            <form onSubmit={requestRefund}>
              <h4 style={{ marginBottom: 12 }}>Refund a captured payment</h4>
              <div className="row" style={{ gap: 12 }}>
                <div className="field">
                  <label htmlFor="refund-amount">Amount (KES)</label>
                  <input
                    id="refund-amount"
                    required
                    inputMode="decimal"
                    value={refund.amount}
                    onChange={(event) =>
                      setRefund({ ...refund, amount: event.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="refund-reason">Reason</label>
                  <input
                    id="refund-reason"
                    required
                    minLength={5}
                    value={refund.reason}
                    onChange={(event) =>
                      setRefund({ ...refund, reason: event.target.value })
                    }
                  />
                </div>
              </div>
              <div className="form-actions">
                <button
                  className="btn outline sm"
                  type="submit"
                  disabled={working}
                >
                  Request refund
                </button>
              </div>
            </form>
          </>
        )}
      </Overlay>
    </div>
  );
}
