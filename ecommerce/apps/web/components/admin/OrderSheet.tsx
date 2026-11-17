"use client";

import { useEffect, useState } from "react";
import { Overlay } from "@/components/ui/Overlay";
import { useToast } from "@/components/ui/Toast";
import { Status } from "@/components/admin/atoms";
import {
  SHIPMENT_STATUSES,
  TRANSITIONS,
  money,
  shortId,
  when,
  type OrderDetail,
} from "@/components/admin/types";
import { api, ApiError } from "@/lib/api-client";

/**
 * One order, everything you can do to it: record money, refund, move
 * fulfilment, and ship it. Every list of allowed moves mirrors a server-side
 * table (TRANSITIONS, SHIPMENT_STATUSES) so the UI cannot offer a rejected call.
 */
export function OrderSheet({
  order,
  onClose,
  onChanged,
}: {
  order: OrderDetail | null;
  onClose: () => void;
  /** Called after a successful mutation; the parent reloads the order and list. */
  onChanged: () => Promise<void> | void;
}) {
  const { toast } = useToast();
  const [payment, setPayment] = useState({ amount: "", reference: "" });
  const [refund, setRefund] = useState({
    amount: "",
    reason: "",
    restock: false,
  });
  const [transition, setTransition] = useState({ status: "", reason: "" });
  const [shipment, setShipment] = useState({
    carrier: "",
    tracking_number: "",
    tracking_url: "",
  });
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!order) return;
    setPayment({ amount: order.totals.total, reference: "" });
    setRefund({ amount: "", reason: "", restock: false });
    setTransition({ status: TRANSITIONS[order.status]?.[0] ?? "", reason: "" });
    setShipment({ carrier: "", tracking_number: "", tracking_url: "" });
    setQuantities(
      Object.fromEntries(
        order.items.map((line) => [line.order_line_id, line.quantity]),
      ),
    );
  }, [order?.order_id, order?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(
    action: () => Promise<unknown>,
    success: { title: string; description?: string },
    failure: string,
  ) {
    setWorking(true);
    try {
      await action();
      toast(success);
      await onChanged();
    } catch (caught) {
      toast({
        title: failure,
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    } finally {
      setWorking(false);
    }
  }

  if (!order) {
    return (
      <Overlay open={false} onClose={onClose} title="Order">
        <div className="skeleton tall" style={{ height: "8rem" }} />
      </Overlay>
    );
  }

  const openLines = order.items.filter(
    (line) => (quantities[line.order_line_id] ?? 0) > 0,
  );

  return (
    <Overlay
      open
      onClose={onClose}
      title={`Order ${order.order_number}`}
      description="Record money, move fulfilment, keep the trail."
      footer={
        <div
          className="cart-grand-total"
          style={{ margin: 0, border: 0, padding: 0, width: "100%" }}
        >
          <span>Total</span>
          <strong>{money(order.totals.total)}</strong>
        </div>
      }
    >
      <div className="row" style={{ marginBottom: 14 }}>
        <Status value={order.status} />
        <Status value={order.payment_status} />
      </div>

      <div className="detail-grid">
        <div>
          <span>Subtotal</span>
          <strong>{money(order.totals.subtotal)}</strong>
        </div>
        <div>
          <span>Delivery</span>
          <strong>{money(order.totals.shipping)}</strong>
        </div>
      </div>

      <div className="list" style={{ marginBottom: 6 }}>
        {order.items.map((line) => (
          <div className="list-row" key={line.order_line_id}>
            <span style={{ flex: 1 }}>
              {line.quantity} × {line.product_name}
              <span className="muted tiny mono"> {line.sku}</span>
            </span>
            <span className="price small">{money(line.line_total)}</span>
          </div>
        ))}
      </div>

      {order.payments.length ? (
        <div style={{ marginTop: 10 }}>
          <h4 style={{ marginBottom: 6 }}>Payments captured</h4>
          {order.payments.map((entry, index) => (
            <div
              className="totals"
              key={`${entry.provider_reference}-${index}`}
            >
              <span className="small">
                {entry.provider_reference} ·{" "}
                {entry.payment_status.replace(/_/g, " ")}
              </span>
              <span className="price small">{money(entry.amount)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <hr className="separator" />

      {/* ------------------------------------------------------- shipments */}
      <h4 style={{ marginBottom: 10 }}>Shipments</h4>
      {order.shipments.length === 0 ? (
        <p className="muted small" style={{ marginBottom: 12 }}>
          Nothing dispatched yet. Creating a shipment marks the order shipped
          and releases the held stock.
        </p>
      ) : (
        <div className="list" style={{ marginBottom: 12 }}>
          {order.shipments.map((entry) => (
            <div
              className="list-row"
              key={entry.shipment_id}
              style={{ alignItems: "flex-start", gap: 12 }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontSize: 11.5 }}>{entry.carrier}</strong>
                <div className="muted tiny">
                  {entry.tracking_number ? (
                    entry.tracking_url ? (
                      <a
                        className="text-link"
                        href={entry.tracking_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {entry.tracking_number}
                      </a>
                    ) : (
                      entry.tracking_number
                    )
                  ) : (
                    "no tracking number"
                  )}
                  {" · "}
                  {entry.delivered_at
                    ? `delivered ${when(entry.delivered_at)}`
                    : `shipped ${when(entry.shipped_at)}`}
                  {" · "}
                  <span className="mono">{shortId(entry.shipment_id)}</span>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Status value={entry.status} />
                <select
                  aria-label={`Update shipment ${shortId(entry.shipment_id)}`}
                  value=""
                  disabled={working}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (!next) return;
                    void run(
                      () =>
                        api(`/admin/shipments/${entry.shipment_id}`, {
                          method: "PATCH",
                          body: { status: next },
                        }),
                      {
                        title: "Shipment updated",
                        description: `${entry.carrier} → ${next.replace(/_/g, " ")}`,
                      },
                      "Could not update the shipment",
                    );
                  }}
                >
                  <option value="">Set status…</option>
                  {SHIPMENT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const lines = openLines.map((line) => ({
            order_line_id: line.order_line_id,
            quantity: quantities[line.order_line_id],
          }));
          if (lines.length === 0) {
            toast({
              title: "Choose at least one line to ship",
              variant: "error",
            });
            return;
          }
          void run(
            () =>
              api(`/admin/orders/${order.order_id}/shipments`, {
                method: "POST",
                body: {
                  carrier: shipment.carrier,
                  tracking_number: shipment.tracking_number || undefined,
                  tracking_url: shipment.tracking_url || undefined,
                  lines,
                },
              }),
            {
              title: "Shipment created",
              description: `${order.order_number} · ${shipment.carrier}`,
            },
            "Could not create the shipment",
          );
        }}
      >
        <div className="row" style={{ gap: 12 }}>
          <div className="field">
            <label htmlFor="carrier">Carrier</label>
            <input
              id="carrier"
              required
              minLength={2}
              placeholder="e.g. G4S Courier"
              value={shipment.carrier}
              onChange={(event) =>
                setShipment({ ...shipment, carrier: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="tracking-number">Tracking number (optional)</label>
            <input
              id="tracking-number"
              value={shipment.tracking_number}
              onChange={(event) =>
                setShipment({
                  ...shipment,
                  tracking_number: event.target.value,
                })
              }
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="tracking-url">Tracking URL (optional)</label>
          <input
            id="tracking-url"
            type="url"
            placeholder="https://…"
            value={shipment.tracking_url}
            onChange={(event) =>
              setShipment({ ...shipment, tracking_url: event.target.value })
            }
          />
        </div>

        <div className="list" style={{ marginBottom: 10 }}>
          {order.items.map((line) => (
            <div className="list-row" key={line.order_line_id}>
              <span style={{ flex: 1 }}>
                {line.product_name}
                <span className="muted tiny"> · ordered {line.quantity}</span>
              </span>
              <input
                type="number"
                min={0}
                max={line.quantity}
                step={1}
                aria-label={`Quantity to ship of ${line.product_name}`}
                value={quantities[line.order_line_id] ?? 0}
                onChange={(event) =>
                  setQuantities({
                    ...quantities,
                    [line.order_line_id]: Math.max(
                      0,
                      Math.min(line.quantity, Number(event.target.value)),
                    ),
                  })
                }
                style={{ width: 74, textAlign: "center" }}
              />
            </div>
          ))}
        </div>

        <div className="form-actions">
          <button className="btn primary sm" type="submit" disabled={working}>
            Create shipment
          </button>
          <span className="muted tiny">
            Marks the order shipped and notifies nothing yet — the customer sees
            it on their order page.
          </span>
        </div>
      </form>

      <hr className="separator" />

      {/* ------------------------------------------------------- fulfilment */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            () =>
              api(`/admin/orders/${order.order_id}/status`, {
                method: "PATCH",
                body: { status: transition.status, reason: transition.reason },
              }),
            {
              title: "Order moved",
              description: `${order.order_number} → ${transition.status.replace(/_/g, " ")}`,
            },
            "Could not move the order",
          );
        }}
      >
        <h4 style={{ marginBottom: 12 }}>Move fulfilment</h4>
        {TRANSITIONS[order.status]?.length ? (
          <>
            <div className="row" style={{ gap: 12 }}>
              <div className="field">
                <label htmlFor="next-status">Next status</label>
                <select
                  id="next-status"
                  value={transition.status}
                  onChange={(event) =>
                    setTransition({ ...transition, status: event.target.value })
                  }
                >
                  {TRANSITIONS[order.status].map((status) => (
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
                  onChange={(event) =>
                    setTransition({ ...transition, reason: event.target.value })
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
            {order.status} is terminal — no further transitions.
          </p>
        )}
      </form>

      <hr className="separator" />

      {/* ---------------------------------------------------------- payment */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            () =>
              api(`/admin/orders/${order.order_id}/payments`, {
                method: "POST",
                body: { amount: payment.amount, reference: payment.reference },
              }),
            {
              title: "Payment recorded",
              description: `${order.order_number} · ${money(payment.amount)}`,
            },
            "Could not record the payment",
          );
        }}
      >
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
              minLength={3}
              value={payment.reference}
              onChange={(event) =>
                setPayment({ ...payment, reference: event.target.value })
              }
            />
          </div>
        </div>
        <div className="form-actions">
          <button className="btn secondary sm" type="submit" disabled={working}>
            Record payment
          </button>
        </div>
      </form>

      <hr className="separator" />

      {/* ----------------------------------------------------------- refund */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            () =>
              api(`/admin/orders/${order.order_id}/refunds`, {
                method: "POST",
                idempotencyKey: `admin-refund-${order.order_id}-${Date.now()}`,
                body: {
                  amount: refund.amount,
                  reason: refund.reason,
                  restock: refund.restock,
                },
              }),
            {
              title: "Refund requested",
              description: "Recorded and awaiting settlement.",
            },
            "Could not request the refund",
          );
        }}
      >
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
        <label className="check-field">
          <input
            type="checkbox"
            checked={refund.restock}
            onChange={(event) =>
              setRefund({ ...refund, restock: event.target.checked })
            }
          />
          Return the goods to stock
        </label>
        <div className="form-actions">
          <button className="btn outline sm" type="submit" disabled={working}>
            Request refund
          </button>
        </div>
      </form>
    </Overlay>
  );
}
