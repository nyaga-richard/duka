"use client";
import React, { useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  ArrowDownToLine,
  Plus,
  ShoppingBasket,
  TrendingUp,
  ReceiptText,
  Boxes,
  ChevronRight,
  CalendarDays,
  MoreHorizontal,
  Package,
  Clock3,
  CircleCheck,
  AlertTriangle,
  ArrowRight,
  Wallet,
  Truck,
  Users,
} from "lucide-react";
import {
  useWorkspace,
  useQuery,
  currency,
  number,
  dateText,
  scopedQuery,
  rangeDates,
  D,
  download,
} from "./lib";
import {
  Button,
  PageHeading,
  ErrorCard,
  ProductAvatar,
  Badge,
  DataTable,
} from "./ui";
function RevenueChart({
  data,
  from,
  to,
}: {
  data: any[];
  from: string;
  to: string;
}) {
  const dates: string[] = [];
  const start = new Date(from + "T12:00:00Z"),
    end = new Date(to + "T12:00:00Z");
  for (
    let d = new Date(start);
    d <= end && dates.length < 366;
    d.setUTCDate(d.getUTCDate() + 1)
  )
    dates.push(d.toISOString().slice(0, 10));
  const map = new Map(data.map((d) => [d.date, Number(d.total)]));
  const values = dates.map((d) => map.get(d) ?? 0);
  const max = Math.max(...values, 100);
  const width = 740,
    height = 206,
    left = 54,
    right = 18,
    top = 14,
    bottom = 32;
  const plotW = width - left - right,
    plotH = height - top - bottom;
  const points = values.map((v, i) => [
    left + (i / Math.max(1, values.length - 1)) * plotW,
    top + plotH * (1 - v / max),
  ]);
  const path = points
    .map(
      (p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`,
    )
    .join(" ");
  const area =
    path +
    ` L ${points[points.length - 1]?.[0] ?? left},${height - bottom} L ${left},${height - bottom} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="revenue-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Daily gross sales from ${from} to ${to}. Total ${values.reduce((a, b) => a + b, 0)} Kenyan shillings.`}
      >
        <defs>
          <linearGradient id="revenue-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3e9270" stopOpacity=".19" />
            <stop offset="100%" stopColor="#3e9270" stopOpacity=".01" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={left}
              x2={width - right}
              y1={top + plotH * t}
              y2={top + plotH * t}
              stroke="var(--line)"
              strokeDasharray="3 5"
            />
            <text x={left - 12} y={top + plotH * t + 4} textAnchor="end">
              {Math.round(((max * (1 - t)) / 1000) * 10) / 10}k
            </text>
          </g>
        ))}
        <path d={area} fill="url(#revenue-fill)" />
        <path
          d={path}
          fill="none"
          stroke="#34775a"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {points
          .filter((_, i) => i === points.length - 1)
          .map((p, i) => (
            <g key={i}>
              <circle
                cx={p[0]}
                cy={p[1]}
                r={6}
                fill="var(--surface)"
                stroke="#34775a"
                strokeWidth={2}
              />
              <circle cx={p[0]} cy={p[1]} r={2.5} fill="#34775a" />
            </g>
          ))}
        {dates.map((d, i) =>
          i === 0 ||
          i === dates.length - 1 ||
          i % Math.max(1, Math.round(dates.length / 5)) === 0 ? (
            <text
              key={d}
              x={left + (i / Math.max(1, dates.length - 1)) * plotW}
              y={height - 7}
              textAnchor="middle"
            >
              {new Intl.DateTimeFormat("en-GB", {
                day: "numeric",
                month: "short",
              }).format(new Date(d + "T12:00:00Z"))}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}
export default function Dashboard() {
  const { actor, branch, meta, notify } = useWorkspace();
  const [range, setRange] = useState("month");
  const dates = rangeDates(range);
  const query = scopedQuery(dates, branch);
  const { data, loading, error, refresh } = useQuery<any>(
    "/dashboard?" + query,
  );
  const t = data?.totals ?? {};
  const totalPayments =
    data?.payment_methods?.reduce(
      (s: any, m: any) => s.plus(D(m.amount).gt(0) ? m.amount : 0),
      D(0),
    ) ?? D(0);
  const greeting = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    hour12: false,
    timeZone: meta.company.timezone,
  }).format(new Date());
  const time =
    Number(greeting) < 12
      ? "morning"
      : Number(greeting) < 17
        ? "afternoon"
        : "evening";
  const today = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: meta.company.timezone,
  }).format(new Date());
  const stats = [
    {
      label: "Net sales",
      value: currency(t.sales, meta.company.currency),
      icon: ShoppingBasket,
      note: "Gross sales less returns",
      tone: "green",
    },
    {
      label: "Gross profit",
      value:
        t.gross_profit === null
          ? "Restricted"
          : currency(t.gross_profit, meta.company.currency),
      icon: TrendingUp,
      note: "Net revenue less cost of goods",
      tone: "amber",
    },
    {
      label: "Transactions",
      value: number(t.transactions),
      icon: ReceiptText,
      note: `${number(t.return_count)} returns in this period`,
      tone: "blue",
    },
    {
      label: "Inventory value",
      value:
        t.stock_value === null
          ? "Restricted"
          : currency(t.stock_value, meta.company.currency),
      icon: Boxes,
      note: "Perpetual weighted-average value",
      tone: "purple",
    },
  ];
  async function exportReport() {
    try {
      await download(
        "/reports/sales?" + query + "&format=csv&limit=100",
        "sales-summary.csv",
      );
      notify("Sales summary exported.");
    } catch (e: any) {
      notify(e.message, "error");
    }
  }
  return (
    <>
      <PageHeading
        eyebrow={today.toUpperCase()}
        title={`Good ${time}, ${actor.name.split(" ")[0]} ☀`}
        description="Here’s how your business is doing. Let’s make today a good one."
      >
        <Button variant="secondary" onClick={exportReport}>
          <ArrowDownToLine size={16} /> Export report
        </Button>
        {actor.permissions.includes("sales.create") && (
          <Link className="btn primary" href="/pos">
            <Plus size={18} /> New sale
          </Link>
        )}
      </PageHeading>
      <div className="overview-toolbar">
        <div>
          <span className="section-dot" />
          <strong>Business overview</strong>
          <Badge status="active">Live workspace</Badge>
        </div>
        <label className="range-select">
          <CalendarDays size={15} />
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            aria-label="Dashboard date range"
          >
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="month">This month</option>
          </select>
          <ChevronRight size={14} />
        </label>
      </div>
      {error && <ErrorCard error={error} retry={refresh} />}
      <section className="stat-grid" aria-label="Business metrics">
        {stats.map((s, i) => (
          <article className="stat-card" key={s.label}>
            <div className="stat-top">
              <span>{s.label}</span>
              <span className={`stat-icon ${s.tone}`}>
                <s.icon size={19} />
              </span>
            </div>
            <strong className={loading ? "skeleton" : ""}>
              {loading ? "" : s.value}
            </strong>
            <div className="stat-bottom">
              <span>{s.note}</span>
              <ArrowUpRight size={15} />
            </div>
          </article>
        ))}
      </section>
      <div className="dashboard-main-grid">
        <section className="card revenue-panel">
          <div className="card-heading">
            <div>
              <h2>
                Sales performance{" "}
                <span className="chart-legend">
                  <i /> Gross sales
                </span>
              </h2>
              <p>Your daily sales, at a glance.</p>
            </div>
            <div className="chart-summary">
              <strong>{currency(t.sales, meta.company.currency)}</strong>
              <span>
                net of {currency(t.returns, meta.company.currency)} returns
              </span>
            </div>
          </div>
          <RevenueChart
            data={data?.trend ?? []}
            from={dates.from}
            to={dates.to}
          />
          <div className="chart-footer">
            <span>
              <span className="tiny-dot" /> Recorded sales · server-confirmed
              transactions only
            </span>
            <Link href="/reports">
              View analytics <ArrowUpRight size={14} />
            </Link>
          </div>
        </section>
        <section className="card payment-panel">
          <div className="card-heading">
            <div>
              <h2>Payment mix</h2>
              <p>Money in, by payment method.</p>
            </div>
            <Wallet size={19} className="muted" />
          </div>
          <div className="payment-donut-wrap">
            <div
              className="payment-donut"
              style={{
                background: !data?.payment_methods?.length
                  ? "var(--line)"
                  : `conic-gradient(${(() => {
                      let cursor = 0;
                      const colors = [
                        "#285d49",
                        "#a7cbaa",
                        "#e6bc80",
                        "#a6b4cc",
                        "#c3b6c8",
                      ];
                      return (data?.payment_methods ?? [])
                        .map((m: any, i: number) => {
                          const value = totalPayments.gt(0)
                            ? D(m.amount)
                                .div(totalPayments)
                                .times(100)
                                .toNumber()
                            : 0;
                          const start = cursor;
                          cursor += Math.max(0, value);
                          return `${colors[i % 5]} ${start}% ${cursor}%`;
                        })
                        .join(",");
                    })()})`,
              }}
            >
              <div>
                <small>Net tenders</small>
                <strong>
                  {currency(totalPayments, meta.company.currency, true)}
                </strong>
              </div>
            </div>
          </div>
          <div className="payment-legend">
            {(data?.payment_methods ?? [])
              .slice(0, 4)
              .map((m: any, i: number) => (
                <div key={m.name}>
                  <span>
                    <i
                      style={{
                        background: [
                          "#285d49",
                          "#a7cbaa",
                          "#e6bc80",
                          "#a6b4cc",
                        ][i],
                      }}
                    />
                    {m.name}
                  </span>
                  <strong>{currency(m.amount, meta.company.currency)}</strong>
                </div>
              ))}
          </div>
        </section>
      </div>
      <div className="dashboard-secondary-grid">
        <section className="card recent-panel">
          <div className="card-heading">
            <div>
              <h2>Recent transactions</h2>
              <p>The latest activity across your business.</p>
            </div>
            <Link className="text-link" href="/sales">
              View all <ArrowUpRight size={15} />
            </Link>
          </div>
          <DataTable
            columns={[
              {
                key: "number",
                title: "Invoice",
                render: (r) => (
                  <Link className="reference-link" href={"/sales?open=" + r.id}>
                    {r.number}
                  </Link>
                ),
              },
              {
                key: "customer",
                title: "Customer",
                render: (r) => (
                  <div className="customer-cell">
                    <span className="mini-avatar">
                      {(r.customer ?? "Walk in")[0]}
                    </span>
                    <div>
                      <strong>{r.customer ?? "Walk-in customer"}</strong>
                      <small>{dateText(r.created_at, true)}</small>
                    </div>
                  </div>
                ),
              },
              {
                key: "total",
                title: "Amount",
                align: "right",
                render: (r) => (
                  <strong>{currency(r.total, meta.company.currency)}</strong>
                ),
              },
              {
                key: "status",
                title: "Status",
                render: (r) => (
                  <Badge status={D(r.outstanding).lte(0) ? "paid" : "partial"}>
                    {D(r.outstanding).lte(0) ? "Settled" : "Open balance"}
                  </Badge>
                ),
              },
            ]}
            items={data?.recent_sales ?? []}
            loading={loading}
          />
        </section>
        <section className="card attention-panel">
          <div className="card-heading">
            <div>
              <h2>
                <span className="attention-dot" /> Stock watch
              </h2>
              <p>A little attention goes a long way.</p>
            </div>
            <Link href="/inventory" aria-label="View inventory">
              <ArrowUpRight size={18} />
            </Link>
          </div>
          <div className="stock-watch-list">
            {(data?.low_stock ?? []).length ? (
              (data?.low_stock ?? []).slice(0, 4).map((p: any) => (
                <div className="stock-watch-item" key={p.id}>
                  <ProductAvatar name={p.name} small />
                  <div>
                    <strong>{p.name}</strong>
                    <small>
                      {p.sku} · {p.warehouse}
                    </small>
                  </div>
                  <span className="stock-low">{number(p.stock)} left</span>
                </div>
              ))
            ) : (
              <div className="empty small-empty">
                <CircleCheck size={28} />
                <strong>Stock is looking healthy.</strong>
              </div>
            )}
          </div>
          <Link className="stock-watch-footer" href="/purchasing">
            Plan a restock <ArrowRight size={16} />
          </Link>
        </section>
      </div>
      <div className="dashboard-bottom-grid">
        <section className="card top-products-panel">
          <div className="card-heading">
            <div>
              <h2>Your bestsellers</h2>
              <p>The products your customers keep coming back for.</p>
            </div>
            <Link className="text-link" href="/reports">
              Product report <ArrowUpRight size={15} />
            </Link>
          </div>
          <div className="bestseller-list">
            {(data?.top_products ?? []).slice(0, 4).map((p: any, i: number) => (
              <div className="bestseller" key={p.id}>
                <span className="rank">{String(i + 1).padStart(2, "0")}</span>
                <ProductAvatar name={p.name} small />
                <div className="bestseller-info">
                  <strong>{p.name}</strong>
                  <small>
                    {p.category ?? "Uncategorized"} · {number(p.quantity)} sold
                  </small>
                </div>
                <div className="bestseller-bar">
                  <i
                    style={{
                      width:
                        (data.top_products[0]
                          ? D(p.revenue)
                              .div(data.top_products[0].revenue || 1)
                              .times(100)
                              .toNumber()
                          : 0) + "%",
                    }}
                  />
                </div>
                <strong>{currency(p.revenue, meta.company.currency)}</strong>
              </div>
            ))}
          </div>
        </section>
        <section className="business-pulse">
          <span className="pulse-ornament" aria-hidden="true">
            ↗
          </span>
          <span className="eyebrow">KEEP YOUR BUSINESS IN BALANCE</span>
          <h2>
            A clearer view.
            <br />A better next move.
          </h2>
          <p>
            Your sales, stock and books are connected.
            <br />
            Keep the momentum going.
          </p>
          <div className="pulse-balances">
            <div>
              <span>Customers owe you</span>
              <strong>{currency(t.receivables, meta.company.currency)}</strong>
            </div>
            <div>
              <span>Supplier balances</span>
              <strong>
                {t.payables === null
                  ? "Restricted"
                  : currency(t.payables, meta.company.currency)}
              </strong>
            </div>
          </div>
          <Link href="/accounting">
            Open your books <ArrowUpRight size={17} />
          </Link>
        </section>
      </div>
    </>
  );
}
