"use client";
import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  CreditCard,
  Landmark,
  Package,
  Printer,
  Receipt,
  Rocket,
  TriangleAlert,
  Warehouse,
} from "lucide-react";
import { useQuery } from "../lib";
import { Badge, Button, PageHeading } from "../ui";

type Domain = {
  key: string;
  title: string;
  icon: any;
  href: string;
  ready: boolean;
  summary: string;
  hint: string;
};

export function SetupPage() {
  const status = useQuery<any>("/setup/status");

  if (status.error)
    return (
      <div className="empty">
        <TriangleAlert size={40} />
        <h1>Setup status unavailable</h1>
        <p>{status.error.message ?? "Please retry in a moment."}</p>
        <Button variant="secondary" onClick={() => status.refresh()}>
          Retry
        </Button>
      </div>
    );

  const data = status.data;
  const domains: Domain[] = data
    ? [
        {
          key: "business",
          title: "Business profile",
          icon: Building2,
          href: "/settings",
          ready: data.domains.business.ready,
          summary: `${data.domains.business.profile.name} · ${data.domains.business.profile.currency} · ${data.domains.business.profile.timezone}${
            data.domains.business.pin
              ? ""
              : " · KRA PIN not recorded"
          }`,
          hint: data.domains.business.pin
            ? "Legal name, currency, timezone and tax registration are set."
            : "Add the KRA PIN before issuing fiscal receipts.",
        },
        {
          key: "receipt",
          title: "Receipts",
          icon: Printer,
          href: "/settings",
          ready: data.domains.receipt.ready,
          summary: `${data.domains.receipt.width} mm paper${
            data.domains.receipt.logo ? " · custom logo" : ""
          }${data.domains.receipt.policy ? " · return policy" : ""}`,
          hint: "Footer text, paper width and optional logo live in Settings.",
        },
        {
          key: "accounting",
          title: "Accounting core",
          icon: Landmark,
          href: "/accounting",
          ready: data.domains.accounting.ready,
          summary: `${data.domains.accounting.accounts} accounts · ${data.domains.accounting.periods} periods`,
          hint: "Chart of accounts and financial periods are provisioned and immutable system defaults are enforced.",
        },
        {
          key: "payments",
          title: "Payment methods",
          icon: CreditCard,
          href: "/settings",
          ready: data.domains.payments.ready,
          summary: `${data.domains.payments.methods} tender methods configured`,
          hint: "Cash, M-Pesa, bank, card and cheque arrive wired to their own accounts; add merchant tills if needed.",
        },
        {
          key: "catalog",
          title: "Catalog",
          icon: Package,
          href: "/products",
          ready: data.domains.catalog.ready,
          summary: `${data.domains.catalog.products} products · ${data.domains.catalog.categories} categories`,
          hint: data.domains.catalog.ready
            ? "Products and services are sellable at the register."
            : "Add your first product or service to start selling.",
        },
        {
          key: "inventory",
          title: "Inventory locations",
          icon: Warehouse,
          href: "/inventory",
          ready: data.domains.inventory.ready,
          summary: `${data.domains.inventory.warehouses} warehouses · ${data.domains.inventory.registers} registers`,
          hint: "Branches, warehouses and registers hold stock; record verified opening stock documents.",
        },
        {
          key: "openings",
          title: "Opening balances",
          icon: Receipt,
          href: "/accounting",
          ready: data.domains.openings.ready,
          summary: `${data.domains.openings.posted} posted · ${data.domains.openings.drafts} drafts · ${data.domains.openings.submitted} awaiting approval`,
          hint: data.domains.openings.ready
            ? "Cutover is clean: no unfinished legacy imports."
            : "A legacy import is half-finished. Review and post or discard it before trading.",
        },
      ]
    : [];
  const readyCount = domains.filter((x) => x.ready).length;

  return (
    <div className="page">
      <PageHeading
        eyebrow="FIRST-RUN SETUP"
        title="Get the business ready to trade"
        description="Seven safe, reversible configuration areas. Each is server-verified — nothing here can leave your books in an inconsistent state."
      >
        <Button variant="secondary" onClick={() => status.refresh()}>
          Recheck
        </Button>
      </PageHeading>

      {data?.demo ? (
        <div className="setup-banner" role="status">
          <Rocket size={18} />
          <p>
            <strong>Demo workspace.</strong> The data here ships with the
            isolated demo accounts (<code>@duka.test</code>) and is disposable;
            it is never mixed with a production business.
          </p>
        </div>
      ) : null}

      <div className="setup-progress card">
        <div className="setup-progress-text">
          <Badge status={data?.completed ? "active" : "pending"}>
            {data
              ? data.completed
                ? "Ready to trade"
                : `${readyCount} of ${domains.length} ready`
              : "Checking…"}
          </Badge>
          {data?.firstRun ? (
            <span className="muted">
              Fresh workspace — no transactions posted yet. This is the safest
              moment to configure everything below.
            </span>
          ) : null}
        </div>
        <progress value={readyCount} max={Math.max(domains.length, 1)} />
      </div>

      <div className="setup-grid">
        {domains.map((m) => (
          <div key={m.key} className={`card setup-card ${m.ready ? "ok" : ""}`}>
            <div className="setup-card-head">
              <m.icon size={20} />
              <h2>{m.title}</h2>
              {m.ready ? (
                <Badge status="active">
                  <BadgeCheck size={12} /> Ready
                </Badge>
              ) : (
                <Badge status="pending">Attention</Badge>
              )}
            </div>
            <p className="summary">{m.summary}</p>
            <p className="muted">{m.hint}</p>
            <Link href={m.href} className="setup-link">
              Configure <ArrowRight size={14} />
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
