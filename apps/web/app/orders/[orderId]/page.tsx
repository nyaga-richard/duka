"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ReviewForm } from "@/components/ReviewForm";
import { api, ApiError } from "@/lib/api-client";

interface OrderView {
  order_id: number;
  order_number: string;
  status: string;
  payment_status: string;
  placed_at: string;
  totals: { subtotal: string; shipping: string; discount: string; tax: string; total: string };
  shipping: { method: string | null; name: string; address_line1: string; city: string; country: string };
  items: Array<{
    order_line_id: number;
    product_name: string;
    sku: string;
    quantity: number;
    unit_price: string;
    line_total: string;
  }>;
  payments: Array<{ amount: string; payment_status: string; provider_reference: string; created_at: string }>;
}

const money = (value: string | number) => `KES ${Number(value).toLocaleString("en-KE")}`;

function tone(status: string): string {
  const value = status.toLowerCase();
  if (["paid", "fulfilled", "delivered", "completed", "captured"].some((word) => value.includes(word))) return "ok";
  if (["cancel", "refund", "fail", "void"].some((word) => value.includes(word))) return "danger";
  if (["pending", "await", "partial", "hold", "unpaid"].some((word) => value.includes(word))) return "warn";
  return "accent";
}

export default function OrderPage() {
  const params = useParams<{ orderId: string }>();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrder(await api<OrderView>(`/orders/${params.orderId}`));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not load this order");
    }
  }, [params.orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancelOrder() {
    if (!confirm("Cancel this order? Held stock returns to the shelf.")) return;
    setCancelling(true);
    try {
      await api(`/orders/${params.orderId}/cancel`, { method: "POST", body: { reason: "Cancelled from the storefront" } });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not cancel this order");
    } finally {
      setCancelling(false);
    }
  }

  if (error) {
    return (
      <main className="narrow">
        <div className="notice error">{error}</div>
        <Link className="button secondary" href="/">
          Back to the shop
        </Link>
      </main>
    );
  }

  if (!order) {
    return (
      <main>
        <div className="skeleton line" style={{ width: "30%", marginBottom: "1rem" }} />
        <div className="split">
          <div className="skeleton" style={{ height: "12rem" }} />
          <div className="skeleton" style={{ height: "10rem" }} />
        </div>
      </main>
    );
  }

  const cancellable = ["placed", "payment_failed"].includes(order.status) && order.payment_status !== "paid";

  return (
    <main>
      <p className="small muted" style={{ marginBottom: "0.8rem" }}>
        <Link href="/">← Back to the shop</Link>
      </p>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Order {order.order_number}</h1>
        <span className={`badge ${tone(order.status)}`}>{order.status.replace(/_/g, " ")}</span>
        <span className={`badge ${tone(order.payment_status)}`}>payment {order.payment_status.replace(/_/g, " ")}</span>
      </div>
      <p className="lede">Placed {new Date(order.placed_at).toLocaleString()}</p>

      <div className="split">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Unit</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={`${item.sku}-${item.product_name}`}>
                  <td>
                    {item.product_name}
                    <div className="small muted">{item.sku}</div>
                  </td>
                  <td className="num">{item.quantity}</td>
                  <td className="num price">{money(item.unit_price)}</td>
                  <td className="num price">{money(item.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {order.status === "delivered" ? (
          <div className="panel" style={{ marginTop: "1rem" }}>
            <h3>Review what you bought</h3>
            <p className="small muted">
              Only verified purchases can be reviewed, once per item. Reviews appear on the product page after
              the store publishes them.
            </p>
            {order.items.map((item) => (
              <div
                key={item.order_line_id}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "0.6rem",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderTop: "1px solid var(--line)",
                  paddingTop: "0.6rem",
                  marginTop: "0.6rem",
                }}
              >
                <span style={{ fontSize: "0.92rem" }}>{item.product_name}</span>
                <ReviewForm orderLineId={item.order_line_id} productName={item.product_name} />
              </div>
            ))}
          </div>
        ) : null}
        <aside className="panel sticky">
          <h3>Summary</h3>
          <div className="totals">
            <span>Subtotal</span>
            <span className="price">{money(order.totals.subtotal)}</span>
          </div>
          <div className="totals">
            <span>Delivery</span>
            <span className="price">{money(order.totals.shipping)}</span>
          </div>
          <div className="totals grand">
            <span>Total</span>
            <span className="price">{money(order.totals.total)}</span>
          </div>
          <p className="small muted" style={{ marginTop: "0.9rem" }}>
            Delivering to {order.shipping.name}, {order.shipping.address_line1}, {order.shipping.city},{" "}
            {order.shipping.country}.
            {order.shipping.method ? ` (${order.shipping.method})` : ""}
          </p>

          {order.payments.length ? (
            <>
              <h4 style={{ fontSize: "0.9rem", marginTop: "1rem" }}>Payments</h4>
              {order.payments.map((payment) => (
                <div className="totals" key={payment.provider_reference}>
                  <span className="small">
                    {payment.provider_reference} · {payment.payment_status.replace(/_/g, " ")}
                  </span>
                  <span className="price small">{money(payment.amount)}</span>
                </div>
              ))}
            </>
          ) : null}

          {cancellable ? (
            <button className="danger block" type="button" disabled={cancelling} onClick={cancelOrder} style={{ marginTop: "1rem" }}>
              {cancelling ? "Cancelling…" : "Cancel order"}
            </button>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
