"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";

interface OrderView {
  order_id: number;
  order_number: string;
  status: string;
  payment_status: string;
  placed_at: string;
  totals: { subtotal: string; shipping: string; discount: string; tax: string; total: string };
  shipping: { method: string | null; name: string; address_line1: string; city: string; country: string };
  items: Array<{ product_name: string; sku: string; quantity: number; unit_price: string; line_total: string }>;
  payments: Array<{ amount: string; payment_status: string; provider_reference: string; created_at: string }>;
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

  if (error) return <main><div className="notice error">{error}</div></main>;
  if (!order) return <main><p className="muted">Loading…</p></main>;

  const cancellable = ["placed", "payment_failed"].includes(order.status) && order.payment_status !== "paid";

  return (
    <main>
      <p className="muted"><Link href="/">← Back to the shop</Link></p>
      <h1>Order {order.order_number}</h1>
      <p className="lede">
        Placed {new Date(order.placed_at).toLocaleString()} · <span className="pill">{order.status}</span> · payment {order.payment_status}
      </p>

      <div className="split">
        <div>
          <table>
            <thead>
              <tr><th>Item</th><th>Qty</th><th>Unit</th><th>Total</th></tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={`${item.sku}-${item.product_name}`}>
                  <td>{item.product_name}<div className="muted">{item.sku}</div></td>
                  <td>{item.quantity}</td>
                  <td className="price">KES {Number(item.unit_price).toLocaleString("en-KE")}</td>
                  <td className="price">KES {Number(item.line_total).toLocaleString("en-KE")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {order.payments.length ? (
            <>
              <h2 style={{ fontSize: "1.05rem", marginTop: "1.5rem" }}>Payments</h2>
              <table>
                <thead><tr><th>Reference</th><th>Status</th><th>Amount</th></tr></thead>
                <tbody>
                  {order.payments.map((payment) => (
                    <tr key={payment.provider_reference}>
                      <td>{payment.provider_reference}</td>
                      <td>{payment.payment_status}</td>
                      <td className="price">KES {Number(payment.amount).toLocaleString("en-KE")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </div>

        <aside className="card" style={{ padding: "1.1rem" }}>
          <h3 style={{ marginTop: 0 }}>Summary</h3>
          <div className="totals"><span>Subtotal</span><span>KES {Number(order.totals.subtotal).toLocaleString("en-KE")}</span></div>
          <div className="totals"><span>Delivery</span><span>KES {Number(order.totals.shipping).toLocaleString("en-KE")}</span></div>
          <div className="totals grand"><span>Total</span><span>KES {Number(order.totals.total).toLocaleString("en-KE")}</span></div>
          <p className="muted" style={{ marginTop: "1rem" }}>
            Delivering to {order.shipping.name}, {order.shipping.address_line1}, {order.shipping.city}, {order.shipping.country}.
            {order.shipping.method ? ` (${order.shipping.method})` : ""}
          </p>
          {cancellable ? (
            <button className="secondary" style={{ width: "100%" }} disabled={cancelling} onClick={cancelOrder}>
              {cancelling ? "Cancelling…" : "Cancel order"}
            </button>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
