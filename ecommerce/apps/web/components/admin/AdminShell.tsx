"use client";

import Link from "next/link";
import { useState } from "react";
import { Brand } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  BoxesIcon,
  ChevronRightIcon,
  CogIcon,
  HelpIcon,
  LogOutIcon,
  MenuIcon,
  PulseIcon,
  ReceiptIcon,
  RefreshIcon,
  StoreIcon,
  SyncIcon,
  UsersIcon,
} from "@/components/icons";
import { TAB_META, type Tab } from "@/components/admin/types";

const TAB_ICONS: Record<Tab, React.ComponentType<{ size?: number }>> = {
  orders: ReceiptIcon,
  catalogue: BoxesIcon,
  customers: UsersIcon,
  sync: SyncIcon,
  activity: PulseIcon,
  settings: CogIcon,
};

/**
 * The ERP app shell: fixed dark sidebar, sticky topbar with breadcrumbs, the
 * page under `.page-content`, and the footer. `with-sidebar` is what reserves
 * the sidebar's width for the main column — without it the content slides
 * underneath the fixed rail.
 */
export function AdminShell({
  tab,
  onTab,
  onSignOut,
  onRefresh,
  refreshing,
  email,
  children,
}: {
  tab: Tab;
  onTab: (tab: Tab) => void;
  onSignOut: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  email: string;
  children: React.ReactNode;
}) {
  const [mobileNav, setMobileNav] = useState(false);
  const current = TAB_META.find((entry) => entry.id === tab)!;
  const groups = Array.from(new Set(TAB_META.map((entry) => entry.group)));

  return (
    <div className="app-layout with-sidebar">
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
            <small>{email || "Storefront · KES"}</small>
          </div>
        </div>
        <nav aria-label="Store desk navigation">
          {groups.map((group) => (
            <div key={group}>
              <div className="nav-group">{group}</div>
              {TAB_META.filter((entry) => entry.group === group).map(
                (entry) => {
                  const Icon = TAB_ICONS[entry.id];
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={`nav-item ${tab === entry.id ? "active" : ""}`}
                      aria-current={tab === entry.id ? "page" : undefined}
                      onClick={() => {
                        onTab(entry.id);
                        setMobileNav(false);
                      }}
                    >
                      <Icon size={18} />
                      <span>{entry.label}</span>
                    </button>
                  );
                },
              )}
            </div>
          ))}
          <div className="nav-group">Shop</div>
          <Link className="nav-item" href="/">
            <StoreIcon size={18} />
            <span>View storefront</span>
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <button
            className="support-link"
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <HelpIcon size={17} />
            <span>{refreshing ? "Refreshing…" : "Refresh this screen"}</span>
          </button>
          <button className="support-link" type="button" onClick={onSignOut}>
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
              <strong>{current.label}</strong>
            </div>
          </div>
          <div className="topbar-right">
            <button
              className="btn secondary sm"
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
            >
              <RefreshIcon size={14} />
              {refreshing ? "Refreshing" : "Refresh"}
            </button>
            <ThemeToggle />
          </div>
        </header>

        <main className="page-content">
          <div className="page-heading">
            <div>
              <h1>{current.label}</h1>
              <p>{current.description}</p>
            </div>
            <div className="heading-actions">
              <span className="badge outline">
                <span className="status-dot" />
                {email ? "Signed in" : "Store desk"}
              </span>
            </div>
          </div>

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
                onClick={() => onTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {children}
        </main>

        <footer className="app-footer">
          <span>Duka Business OS · store desk</span>
          <span>Prices and stock stay owned by the ERP</span>
        </footer>
      </div>
    </div>
  );
}
