"use client";

import { useCallback, useEffect, useState } from "react";
import { Overlay } from "@/components/ui/Overlay";
import { useToast } from "@/components/ui/Toast";
import { api, ApiError, loadIdentity, newIdempotencyKey } from "@/lib/api-client";

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
  payments: Array<{ amount: string; payment_status: string; provider_reference: string }>;
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
  capabilities: Array<{ id: string; support: string; endpoint?: string; contract?: string }>;
}

type Tab = "orders" | "catalogue" | "sync";

/* ------------------------------------------------------------- utilities */

const money = (value: string | number) => `KES ${Number(value).toLocaleString("en-KE")}`;

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

function tone(status: string): string {
  const value = status.toLowerCase();
  if (["paid", "fulfilled", "delivered", "completed", "captured", "success", "succeeded", "active", "published"].some((word) => value.includes(word)))
    return "ok";
  if (["cancel", "refund", "fail", "void", "archived", "rejected", "error"].some((word) => value.includes(word))) return "danger";
  if (["pending", "await", "partial", "hold", "unpaid", "draft", "queued", "running", "retry"].some((word) => value.includes(word)))
    return "warn";
  return "accent";
}

function Status({ value }: { value: string }) {
  return <span className={`badge ${tone(value)}`}>{value.replace(/[_-]/g, " ")}</span>;
}

function TabButton({
  id,
  label,
  count,
  active,
  onClick,
}: {
  id: Tab;
  label: string;
  count?: number;
  active: boolean;
  onClick: (id: Tab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={active}
      aria-controls={`panel-${id}`}
      className="tab"
      onClick={() => onClick(id)}
    >
      {label}
      {typeof count === "number" ? <span className="count">{count}</span> : null}
    </button>
  );
}

/* ------------------------------------------------------------------ page */

export default function AdminPage() {
  const { toast } = useToast();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState<Tab>("orders");
  const [error, setError] = useState<string | null>(null);

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
      if (caught instanceof ApiError && caught.status === 401) setSignedIn(false);
      else setError(caught instanceof ApiError ? caught.message : "Could not load orders");
    }
  }, []);

  const loadProducts = useCallback(
    async (query: { q: string; status: string }) => {
      setProductsLoading(true);
      try {
        const search = new URLSearchParams({ limit: "25", page: "1" });
        if (query.q.trim()) search.set("q", query.q.trim());
        if (query.status) search.set("status", query.status);
        const data = await api<{ items: AdminProduct[] }>(`/admin/products?${search.toString()}`);
        setProducts(data.items);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : "Could not load the catalogue");
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
      const message = caught instanceof ApiError ? caught.message : "Could not load the sync overview";
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
    if (tab === "catalogue" && products.length === 0) void loadProducts(productQuery);
    if (tab === "sync" && !sync) void loadSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, signedIn]);

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
      setTransition({ status: TRANSITIONS[detail.status]?.[0] ?? "", reason: "" });
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
      toast({ title: "Payment recorded", description: `${selected.order_number} · ${money(payment.amount)}` });
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
      toast({ title: "Refund requested", description: "Recorded and awaiting settlement." });
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
      toast({ title: "Order moved", description: `${selected.order_number} → ${transition.status.replace(/_/g, " ")}` });
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

  async function setProductStatus(product: AdminProduct, status: "draft" | "active" | "archived") {
    try {
      await api(`/admin/products/${product.product_id}/status`, { method: "PATCH", body: { status } });
      setProducts((current) =>
        current.map((row) => (row.product_id === product.product_id ? { ...row, status } : row)),
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

  /* ---------------------------------------------------------------- views */

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
        <span className="small muted" style={{ textTransform: "uppercase", letterSpacing: "0.1em" }}>
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
          <button type="submit" className="btn btn--lg" style={{ width: "100%" }}>
            Sign in
          </button>
        </form>
      </main>
    );
  }

  const recorded = orders.reduce((sum, order) => sum + Number(order.order_total || 0), 0);
  const awaiting = orders.filter((order) => !/paid|captured|refund/i.test(order.payment_status)).length;

  return (
    <main>
      <div className="toolbar" style={{ marginTop: 0 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.7rem" }}>Store desk</h1>
          <p className="lede" style={{ margin: 0 }}>
            Payments, fulfilment and what the storefront is publishing.
          </p>
        </div>
        <span className="grow" />
        <button
          className="btn btn--outline btn--sm"
          type="button"
          onClick={() => {
            void loadOrders();
            if (tab === "catalogue") void loadProducts(productQuery);
            if (tab === "sync") void loadSync();
          }}
        >
          Refresh
        </button>
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      <div className="tabs" role="tablist" aria-label="Store desk sections">
        <TabButton id="orders" label="Orders" count={orders.length} active={tab === "orders"} onClick={setTab} />
        <TabButton id="catalogue" label="Catalogue" count={products.length || undefined} active={tab === "catalogue"} onClick={setTab} />
        <TabButton id="sync" label="ERP sync" active={tab === "sync"} onClick={setTab} />
      </div>

      {/* ------------------------------------------------------ orders tab */}
      {tab === "orders" ? (
        <section role="tabpanel" id="panel-orders" aria-labelledby="tab-orders">
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
                        <button className="btn btn--outline btn--sm" type="button" onClick={() => openOrder(order.order_id)}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* -------------------------------------------------- catalogue tab */}
      {tab === "catalogue" ? (
        <section role="tabpanel" id="panel-catalogue" aria-labelledby="tab-catalogue">
          <form
            className="toolbar"
            style={{ marginTop: 0 }}
            onSubmit={(event) => {
              event.preventDefault();
              void loadProducts(productQuery);
            }}
          >
            <input
              type="search"
              placeholder="Search the catalogue"
              aria-label="Search the catalogue"
              value={productQuery.q}
              onChange={(event) => setProductQuery({ ...productQuery, q: event.target.value })}
              style={{ maxWidth: "20rem" }}
            />
            <select
              aria-label="Filter by status"
              value={productQuery.status}
              onChange={(event) => {
                const next = { ...productQuery, status: event.target.value };
                setProductQuery(next);
                void loadProducts(next);
              }}
            >
              <option value="">All statuses</option>
              <option value="active">Published</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
            <button className="btn btn--sm" type="submit">
              Search
            </button>
            <span className="grow" />
            <span className="small muted">{productsLoading ? "Loading…" : `${products.length} shown`}</span>
          </form>

          <div className="table-wrap">
            <table>
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
                    <td colSpan={5} className="muted">
                      {productsLoading ? "Loading the catalogue…" : "No products match. Pull the catalogue from the ERP or create products locally."}
                    </td>
                  </tr>
                ) : (
                  products.map((product) => (
                    <tr key={product.product_id}>
                      <td>
                        <strong>{product.product_name}</strong>
                        <div className="small muted">
                          /{product.slug}
                          {product.erp_product_id ? ` · ERP #${product.erp_product_id}` : " · local"}
                        </div>
                      </td>
                      <td>
                        <Status value={product.status} />
                      </td>
                      <td>{product.sync_state ? <Status value={product.sync_state} /> : <span className="muted small">—</span>}</td>
                      <td className="num">{product.variants}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {product.status !== "active" ? (
                          <button className="btn btn--sm" type="button" onClick={() => setProductStatus(product, "active")}>
                            Publish
                          </button>
                        ) : (
                          <button
                            className="btn btn--outline btn--sm"
                            type="button"
                            onClick={() => setProductStatus(product, "draft")}
                          >
                            Unpublish
                          </button>
                        )}{" "}
                        {product.status !== "archived" ? (
                          <button
                            className="btn btn--ghost btn--sm"
                            type="button"
                            onClick={() => setProductStatus(product, "archived")}
                          >
                            Archive
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginTop: "0.6rem" }}>
            Stock and prices stay owned by the ERP; this only controls what the storefront publishes.
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------------- sync tab */}
      {tab === "sync" ? (
        <section role="tabpanel" id="panel-sync" aria-labelledby="tab-sync">
          {syncLoading && !sync ? (
            <div className="stat-row">
              <div className="skeleton" style={{ height: "4rem" }} />
              <div className="skeleton" style={{ height: "4rem" }} />
              <div className="skeleton" style={{ height: "4rem" }} />
            </div>
          ) : sync ? (
            <>
              <div className="stat-row">
                <div className="stat">
                  <div className="k">Integration</div>
                  <div className="v" style={{ fontSize: "1.05rem" }}>
                    {sync.enabled ? <span className="badge ok">enabled</span> : <span className="badge warn">disabled</span>}
                  </div>
                </div>
                {["queued", "running", "failed", "succeeded"].map((state) => (
                  <div className="stat" key={state}>
                    <div className="k">Jobs {state}</div>
                    <div className="v">{sync.jobs[state] ?? 0}</div>
                  </div>
                ))}
              </div>

              <div className="card">
                <div className="card-head">
                  <div>
                    <h3 className="card-title">Recent sync activity</h3>
                    <p className="card-desc">Newest 25 entries from the sync log.</p>
                  </div>
                </div>
                <div className="card-content" style={{ paddingTop: 0 }}>
                  <div className="table-wrap">
                    <table>
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
                            <td colSpan={5} className="muted">
                              No sync activity yet.
                            </td>
                          </tr>
                        ) : (
                          sync.recent_logs.map((log) => (
                            <tr key={log.log_id}>
                              <td>
                                {log.entity_type}
                                <div className="small muted">{log.direction}</div>
                              </td>
                              <td>
                                {log.operation}
                                {log.error_code ? <div className="small muted">{log.error_code}</div> : null}
                              </td>
                              <td>
                                <Status value={log.status} />
                              </td>
                              <td className="num">{log.attempts}</td>
                              <td className="small muted">
                                {log.started_at ? new Date(log.started_at).toLocaleString() : "—"}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div className="card" style={{ marginTop: "1rem" }}>
                <div className="card-head">
                  <div>
                    <h3 className="card-title">ERP capabilities</h3>
                    <p className="card-desc">What the adapter has verified against the ERP endpoints.</p>
                  </div>
                </div>
                <div className="card-content" style={{ paddingTop: 0 }}>
                  <div className="list">
                    {sync.capabilities.map((capability) => (
                      <div className="list-row" key={capability.id}>
                        <span style={{ flex: 1, fontFamily: "ui-monospace, monospace", fontSize: "0.82rem" }}>
                          {capability.id}
                        </span>
                        <Status value={capability.support} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="empty">
              <h2>Sync overview unavailable</h2>
              <p>Your admin role may not include the sync permission.</p>
            </div>
          )}
        </section>
      ) : null}

      {/* ------------------------------------------------ order dialog */}
      <Overlay
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={selected ? `Order ${selected.order_number}` : "Order"}
        description={selected ? "Record money, move fulfilment, keep the trail." : undefined}
        footer={
          selected ? (
            <div className="totals grand" style={{ margin: 0 }}>
              <span>Total</span>
              <span className="price">{money(selected.totals.total)}</span>
            </div>
          ) : null
        }
      >
        {!selected ? (
          <div className="skeleton" style={{ height: "8rem" }} />
        ) : (
          <>
            <div className="toolbar" style={{ marginTop: 0 }}>
              <Status value={selected.status} />
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

            <ul className="small muted" style={{ paddingLeft: "1.1rem" }}>
              {selected.items.map((item, index) => (
                <li key={index}>
                  {item.quantity} × {item.product_name}
                </li>
              ))}
            </ul>

            {selected.payments.length ? (
              <p className="small muted">
                Captured:{" "}
                {selected.payments.map((entry) => `${entry.provider_reference} (${entry.payment_status})`).join(", ")}
              </p>
            ) : null}

            <hr className="separator" />

            <form onSubmit={moveOrder}>
              <h4 style={{ fontSize: "0.92rem" }}>Move fulfilment</h4>
              {TRANSITIONS[selected.status]?.length ? (
                <>
                  <div className="row">
                    <div className="field">
                      <label htmlFor="next-status">Next status</label>
                      <select
                        id="next-status"
                        value={transition.status}
                        onChange={(event) => setTransition({ ...transition, status: event.target.value })}
                      >
                        {TRANSITIONS[selected.status].map((status) => (
                          <option key={status} value={status}>
                            {status.replace(/_/g, " ")}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="next-reason">Reason (min 5 characters)</label>
                      <input
                        id="next-reason"
                        required
                        minLength={5}
                        value={transition.reason}
                        onChange={(event) => setTransition({ ...transition, reason: event.target.value })}
                      />
                    </div>
                  </div>
                  <button className="btn btn--sm" type="submit" disabled={working || !transition.status}>
                    Move order
                  </button>
                </>
              ) : (
                <p className="small muted" style={{ marginBottom: 0 }}>
                  {selected.status} is terminal — no further transitions.
                </p>
              )}
            </form>

            <hr className="separator" />

            <form onSubmit={recordPayment}>
              <h4 style={{ fontSize: "0.92rem" }}>Record a manual payment</h4>
              <div className="row">
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
                  <label htmlFor="reference">Reference</label>
                  <input
                    id="reference"
                    required
                    value={payment.reference}
                    onChange={(event) => setPayment({ ...payment, reference: event.target.value })}
                  />
                </div>
              </div>
              <button className="btn btn--sm" type="submit" disabled={working}>
                Record payment
              </button>
            </form>

            <hr className="separator" />

            <form onSubmit={requestRefund}>
              <h4 style={{ fontSize: "0.92rem" }}>Refund a captured payment</h4>
              <div className="row">
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
              </div>
              <button className="btn btn--outline btn--sm" type="submit" disabled={working}>
                Request refund
              </button>
            </form>
          </>
        )}
      </Overlay>
    </main>
  );
}
