"use client";

import { EmptyRow, Panel, StatCard, Status } from "@/components/admin/atoms";
import { CLOSED, money, when, type OrderRow } from "@/components/admin/types";

/**
 * Orders: four stat cards over the ERP's data table. Opening a row hands the
 * id up to the page, which fetches the detail and mounts the order sheet.
 */
export function OrdersTab({
  orders,
  loading,
  onOpen,
}: {
  orders: OrderRow[];
  loading: boolean;
  onOpen: (orderId: number) => void;
}) {
  const recorded = orders.reduce(
    (sum, order) => sum + Number(order.order_total || 0),
    0,
  );
  const awaiting = orders.filter(
    (order) => !/paid|captured|refund/i.test(order.payment_status),
  ).length;
  const open = orders.filter((order) => !CLOSED.has(order.status)).length;

  return (
    <section role="tabpanel" id="panel-orders" aria-labelledby="tab-orders">
      <div className="stat-grid">
        <StatCard
          label="Orders loaded"
          value={orders.length}
          footnote={`${open} still open`}
        />
        <StatCard
          label="Recorded value"
          value={money(recorded)}
          footnote="Across the orders above"
        />
        <StatCard
          label="Awaiting payment"
          value={awaiting}
          footnote={
            awaiting ? "Record a manual payment" : "Nothing outstanding"
          }
        />
        <StatCard
          label="Closed"
          value={orders.length - open}
          footnote="delivered, cancelled or refunded"
        />
      </div>

      <Panel
        title="Recent orders"
        note="Newest first · open an order to take payment, ship it or move it"
        flush
      >
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Status</th>
                <th>Payment</th>
                <th className="num">Total</th>
                <th>Placed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <EmptyRow colSpan={6}>
                  {loading
                    ? "Loading orders…"
                    : "No orders yet. Orders placed on the storefront appear here."}
                </EmptyRow>
              ) : (
                orders.map((order) => (
                  <tr key={order.order_id}>
                    <td>
                      <strong>{order.order_number}</strong>
                      <div className="muted tiny">
                        {order.email ?? "guest"} · {order.line_count} line
                        {order.line_count === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td>
                      <Status value={order.status} />
                    </td>
                    <td>
                      <Status value={order.payment_status} />
                    </td>
                    <td className="num price">{money(order.order_total)}</td>
                    <td className="muted small">{when(order.placed_at)}</td>
                    <td className="num">
                      <span className="row-actions">
                        <button
                          className="btn outline sm"
                          type="button"
                          onClick={() => onOpen(order.order_id)}
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
      </Panel>
    </section>
  );
}
