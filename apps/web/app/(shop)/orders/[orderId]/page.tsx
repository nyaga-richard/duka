"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { OrderDetail, type OrderView } from "@/components/OrderDetail";
import { ReorderButton } from "@/components/ReorderButton";
import { api, ApiError } from "@/lib/api-client";

export default function OrderPage() {
  const params = useParams<{ orderId: string }>();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrder(await api<OrderView>(`/orders/${params.orderId}`));
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not load this order",
      );
    }
  }, [params.orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancelOrder() {
    if (!confirm("Cancel this order? Held stock returns to the shelf.")) return;
    setCancelling(true);
    try {
      await api(`/orders/${params.orderId}/cancel`, {
        method: "POST",
        body: { reason: "Cancelled from the storefront" },
      });
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not cancel this order",
      );
    } finally {
      setCancelling(false);
    }
  }

  if (error) {
    return (
      <main style={{ maxWidth: 620 }}>
        <div className="error-card">{error}</div>
        <p className="muted small">
          Looking for an order you placed as a guest?{" "}
          <Link href="/orders">Find it by number and email</Link>.
        </p>
        <Link className="btn secondary" href="/shop">
          Back to the shop
        </Link>
      </main>
    );
  }

  if (!order) {
    return (
      <main>
        <div className="skeleton" style={{ width: "30%", marginBottom: 16 }} />
        <div className="split">
          <div className="skeleton tall" style={{ height: "12rem" }} />
          <div className="skeleton tall" style={{ height: "10rem" }} />
        </div>
      </main>
    );
  }

  const cancellable =
    ["placed", "payment_failed"].includes(order.status) &&
    order.payment_status !== "paid";

  return (
    <OrderDetail
      order={order}
      canReview
      actions={
        <>
          <ReorderButton items={order.items} className="btn secondary block" />
          {cancellable ? (
            <button
              className="btn danger block"
              type="button"
              disabled={cancelling}
              onClick={cancelOrder}
            >
              {cancelling ? "Cancelling…" : "Cancel order"}
            </button>
          ) : null}
        </>
      }
    />
  );
}
