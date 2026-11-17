"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ReviewForm } from "@/components/ReviewForm";
import { ArrowLeftIcon } from "@/components/icons";

/**
 * Everything that renders one order. Both the signed-in order page and the
 * number+email lookup page use it, so an order looks the same however it was
 * reached; the callers supply the buttons that fit their context (cancel,
 * reorder, back link).
 */
export interface OrderView {
  order_id: number;
  order_number: string;
  status: string;
  payment_status: string;
  currency?: string;
  placed_at: string;
  totals: {
    subtotal: string;
    shipping: string;
    discount: string;
    tax: string;
    total: string;
  };
  shipping: {
    method: string | null;
    name: string;
    address_line1: string;
    address_line2?: string | null;
    city: string;
    region?: string | null;
    postal_code?: string | null;
    country: string;
  };
  email?: string | null;
  items: Array<{
    order_line_id: number;
    variant_id?: number;
    product_id?: number;
    product_name: string;
    sku: string;
    option_summary?: string | null;
    quantity: number;
    unit_price: string;
    line_total: string;
  }>;
  payments: Array<{
    amount: string;
    payment_status: string;
    provider_reference: string;
    created_at: string;
  }>;
  shipments?: Array<{
    shipment_id: number;
    carrier: string | null;
    tracking_number: string | null;
    tracking_url: string | null;
    status: string | null;
    shipped_at: string | null;
    delivered_at: string | null;
  }>;
}

export const money = (value: string | number) =>
  `KES ${Number(value).toLocaleString("en-KE")}`;

export function statusTone(status: string): string {
  const value = status.toLowerCase();
  if (
    ["paid", "fulfilled", "delivered", "completed", "captured"].some((word) =>
      value.includes(word),
    )
  )
    return "ok";
  if (["cancel", "refund", "fail", "void"].some((word) => value.includes(word)))
    return "danger";
  if (
    ["pending", "await", "partial", "hold", "unpaid"].some((word) =>
      value.includes(word),
    )
  )
    return "warn";
  return "accent";
}

export function OrderDetail({
  order,
  backHref = "/",
  backLabel = "Back to the shop",
  actions,
  canReview = false,
}: {
  order: OrderView;
  backHref?: string;
  backLabel?: string;
  actions?: ReactNode;
  canReview?: boolean;
}) {
  return (
    <main>
      <Link
        className="muted small"
        href={backHref}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 14,
        }}
      >
        <ArrowLeftIcon size={13} /> {backLabel}
      </Link>

      <div className="page-heading">
        <div>
          <span className="eyebrow">Order</span>
          <h1>{order.order_number}</h1>
          <p>Placed {new Date(order.placed_at).toLocaleString()}</p>
        </div>
        <div className="heading-actions">
          <span className={`badge ${statusTone(order.status)}`}>
            {order.status.replace(/_/g, " ")}
          </span>
          <span className={`badge ${statusTone(order.payment_status)}`}>
            payment {order.payment_status.replace(/_/g, " ")}
          </span>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <div className="card">
            <div className="card-heading">
              <div>
                <h3>Items</h3>
                <p>
                  {order.items.length} line{order.items.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="data-table">
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
                    <tr key={`${item.order_line_id}`}>
                      <td>
                        {item.product_name}
                        <div className="muted tiny mono">
                          {item.option_summary || item.sku}
                        </div>
                      </td>
                      <td className="num">{item.quantity}</td>
                      <td className="num price">{money(item.unit_price)}</td>
                      <td className="num price">{money(item.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {order.shipments?.length ? (
            <div className="card">
              <div className="card-heading">
                <div>
                  <h3>Shipping</h3>
                  <p>
                    Tracking appears here once the store hands over your parcel.
                  </p>
                </div>
              </div>
              <div className="card-content">
                <div className="list">
                  {order.shipments.map((shipment) => (
                    <div className="list-row" key={shipment.shipment_id}>
                      <span style={{ flex: 1 }}>
                        {shipment.carrier ?? "Courier"}
                        {shipment.tracking_number ? (
                          <span className="muted tiny mono">
                            {" "}
                            {shipment.tracking_number}
                          </span>
                        ) : null}
                      </span>
                      {shipment.tracking_url ? (
                        <a
                          className="btn outline sm"
                          href={shipment.tracking_url}
                          rel="noreferrer noopener"
                          target="_blank"
                        >
                          Track parcel
                        </a>
                      ) : null}
                      <span
                        className={`badge ${statusTone(shipment.status ?? "")}`}
                      >
                        {(shipment.status ?? "pending").replace(/_/g, " ")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {canReview && order.status === "delivered" ? (
            <div className="card">
              <div className="card-heading">
                <div>
                  <h3>Review what you bought</h3>
                  <p>
                    Only verified purchases can be reviewed, once per item.
                    Reviews appear after the store publishes them.
                  </p>
                </div>
              </div>
              <div className="card-content">
                <div className="list">
                  {order.items.map((item) => (
                    <div className="list-row" key={item.order_line_id}>
                      <span style={{ flex: 1 }}>{item.product_name}</span>
                      <ReviewForm
                        orderLineId={item.order_line_id}
                        productName={item.product_name}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <aside className="card sticky">
          <div className="card-heading">
            <h3>Summary</h3>
          </div>
          <div className="card-content">
            <div className="totals">
              <span>Subtotal</span>
              <span className="price">{money(order.totals.subtotal)}</span>
            </div>
            <div className="totals">
              <span>Delivery</span>
              <span className="price">{money(order.totals.shipping)}</span>
            </div>
            <div className="cart-grand-total">
              <span>Total</span>
              <strong>{money(order.totals.total)}</strong>
            </div>
            <p className="muted small">
              Delivering to {order.shipping.name},{" "}
              {order.shipping.address_line1}, {order.shipping.city},{" "}
              {order.shipping.country}
              {order.shipping.method ? ` (${order.shipping.method})` : ""}.
            </p>

            {order.payments.length ? (
              <>
                <hr className="separator" />
                <h4 style={{ marginBottom: 8 }}>Payments</h4>
                {order.payments.map((payment) => (
                  <div className="totals" key={payment.provider_reference}>
                    <span className="small">
                      {payment.provider_reference} ·{" "}
                      {payment.payment_status.replace(/_/g, " ")}
                    </span>
                    <span className="price small">{money(payment.amount)}</span>
                  </div>
                ))}
              </>
            ) : null}

            {actions ? (
              <div className="stack" style={{ marginTop: 14, gap: 8 }}>
                {actions}
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </main>
  );
}
