"use client";
import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  ShoppingBasket,
  ReceiptText,
  Package,
  Boxes,
  Truck,
  Users,
  Building2,
  BookOpen,
  Wallet,
  ChartNoAxesCombined,
  Clock3,
  ShieldCheck,
  Settings2,
  ScrollText,
  Plug,
  WifiOff,
  Search,
  ChevronDown,
  ArrowUpRight,
  Bell,
  Sun,
  Moon,
  LogOut,
  Menu,
  X,
  HelpCircle,
  Command,
  ArrowRight,
  Eye,
  EyeOff,
  Check,
  Store,
  Files,
  CheckCheck,
  ChevronRight,
  LoaderCircle,
  Rocket,
} from "lucide-react";
import {
  api,
  setCsrf,
  useQuery,
  useDebounce,
  WorkspaceContext,
  privateStore,
  clearUncertainRequests,
  hasUncertainRequests,
  setCommandActor,
} from "./lib";
import { Button, Dialog, ErrorCard, SearchBox } from "./ui";
import Dashboard from "./Dashboard";
import POS from "./POS";
import {
  CatalogPage,
  ContactsPage,
  SalesPage,
  InventoryPage,
  PurchasingPage,
  DocumentsPage,
  ExpensesPage,
  ShiftsPage,
  AccountingPage,
  ReportsPage,
  TeamPage,
  SettingsPage,
  AuditPage,
  IntegrationsPage,
  OfflinePage,
  SetupPage,
} from "./modules";
const navigation = [
  {
    label: "First-run setup",
    href: "/setup",
    icon: Rocket,
    permission: "settings.manage",
    group: "GETTING STARTED",
  },
  {
    label: "Overview",
    href: "/",
    icon: LayoutDashboard,
    permission: "dashboard.read",
    group: "WORKSPACE",
  },
  {
    label: "Point of sale",
    href: "/pos",
    icon: ShoppingBasket,
    permission: "sales.create",
    group: "",
  },
  {
    label: "Sales & invoices",
    href: "/sales",
    icon: ReceiptText,
    permission: "sales.read",
    group: "",
  },
  {
    label: "Customers",
    href: "/customers",
    icon: Users,
    permission: "customers.read",
    group: "",
  },
  {
    label: "Products",
    href: "/products",
    icon: Package,
    permission: "catalog.read",
    group: "OPERATIONS",
  },
  {
    label: "Inventory",
    href: "/inventory",
    icon: Boxes,
    permission: "inventory.read",
    group: "",
  },
  {
    label: "Purchasing",
    href: "/purchasing",
    icon: Truck,
    permission: "purchases.read",
    group: "",
  },
  {
    label: "Suppliers",
    href: "/suppliers",
    icon: Building2,
    permission: "suppliers.read",
    group: "",
  },
  {
    label: "Documents",
    href: "/documents",
    icon: Files,
    permission: "documents.write",
    group: "",
  },
  {
    label: "Accounting",
    href: "/accounting",
    icon: BookOpen,
    permission: "accounting.read",
    group: "FINANCE",
  },
  {
    label: "Expenses",
    href: "/expenses",
    icon: Wallet,
    permission: "expenses.read",
    group: "",
  },
  {
    label: "Cashier shifts",
    href: "/shifts",
    icon: Clock3,
    permission: "shifts.open|shifts.manage|shifts.review",
    group: "",
  },
  {
    label: "Reports",
    href: "/reports",
    icon: ChartNoAxesCombined,
    permission: "reports.read",
    group: "",
  },
  {
    label: "Team & access",
    href: "/team",
    icon: ShieldCheck,
    permission: "users.manage",
    group: "ADMINISTRATION",
  },
  {
    label: "Audit trail",
    href: "/audit",
    icon: ScrollText,
    permission: "audits.read",
    group: "",
  },
  {
    label: "Integrations",
    href: "/integrations",
    icon: Plug,
    permission: "integrations.manage",
    group: "",
  },
  {
    label: "Offline & sync",
    href: "/offline",
    icon: WifiOff,
    permission: "sales.create",
    group: "",
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings2,
    permission: "settings.manage",
    group: "",
  },
];
function Brand({ dark = false }: { dark?: boolean }) {
  return (
    <div className={`brand ${dark ? "dark" : ""}`}>
      <img src="/icon.svg" alt="" width={38} height={38} />
      <span>
        duka<span className="brand-dot">.</span>
      </span>
      <small>BUSINESS OS</small>
    </div>
  );
}
function Login({ onSignedIn }: { onSignedIn: () => Promise<boolean> }) {
  const pathname = usePathname(),
    params = useSearchParams();
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [totp, setTotp] = useState(""),
    [mfa, setMfa] = useState(false),
    [show, setShow] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<any>(null),
    [forgot, setForgot] = useState(false),
    [sent, setSent] = useState(false);
  const reset = pathname === "/reset-password";
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (reset) {
        await api("/auth/reset-password", {
          method: "POST",
          body: { token: params.get("token") ?? "", password },
        });
        setSent(true);
      } else if (forgot) {
        await api("/auth/forgot-password", { method: "POST", body: { email } });
        setSent(true);
      } else {
        const r: any = await api("/auth/login", {
          method: "POST",
          body: { email, password, ...(totp ? { totp } : {}) },
        });
        setCsrf(r.csrf_token);
        if (!(await onSignedIn()))
          throw new Error(
            "Sign-in could not restore a usable session. If this workspace is embedded, allow its cookies or open it in a new tab, then try again. Your password has not been changed.",
          );
      }
    } catch (e: any) {
      if (e.code === "MFA_REQUIRED") setMfa(true);
      else setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-layout">
      <section className="login-story">
        <Brand />
        <div className="story-copy">
          <span className="story-eyebrow">
            <span /> MADE FOR THE WAY YOU DO BUSINESS
          </span>
          <h1>
            Your business.
            <br />
            Working together.
          </h1>
          <p>
            From the first sale to the final balance.
            <br />
            One connected workspace for everything you do.
          </p>
          <div className="story-grid">
            <div>
              <ShoppingBasket />
              <strong>Sell with confidence</strong>
              <span>Fast checkout, every payment method.</span>
            </div>
            <div>
              <Boxes />
              <strong>Know your stock</strong>
              <span>Every item. Every location. Every movement.</span>
            </div>
            <div>
              <BookOpen />
              <strong>Keep your books connected</strong>
              <span>Real double-entry accounting, built in.</span>
            </div>
          </div>
        </div>
        <div className="login-story-footer">
          <span>Built for your next chapter.</span>
          <span>Nairobi, Kenya ↗</span>
        </div>
        <div className="story-orbit" aria-hidden="true" />
      </section>
      <section className="login-form-panel">
        <div className="login-form-wrap">
          <div className="login-mobile-brand">
            <Brand dark />
          </div>
          <span className="eyebrow">WELCOME TO YOUR WORKSPACE</span>
          <h2>
            {reset
              ? "Set a new password"
              : forgot
                ? "Forgot your password?"
                : "Good to see you again."}
          </h2>
          <p>
            {reset
              ? "Choose a strong password. All existing sessions will be revoked."
              : forgot
                ? "We’ll send a reset link if your account is active."
                : "Sign in to keep your business moving."}
          </p>
          {error && <ErrorCard error={error} />}{" "}
          {sent ? (
            <div className="success-panel">
              <CheckCheck size={32} />
              <h3>{reset ? "Password updated" : "Check your inbox"}</h3>
              <p>
                {reset
                  ? "You can now sign in with your new password."
                  : "If an active account exists, a reset link has been sent. In development, mail is kept in the private database outbox."}
              </p>
              <a href="/">Back to sign in</a>
            </div>
          ) : (
            <form onSubmit={submit}>
              <label className="field">
                <span>Email address</span>
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@yourbusiness.com"
                  required={!reset}
                  hidden={reset}
                />
              </label>
              {!forgot && (
                <label className="field">
                  <span>{reset ? "New password" : "Password"}</span>
                  <div className="password-input">
                    <input
                      type={show ? "text" : "password"}
                      autoComplete={reset ? "new-password" : "current-password"}
                      value={password}
                      minLength={reset ? 12 : undefined}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password"
                      required
                    />
                    <button
                      type="button"
                      aria-label={show ? "Hide password" : "Show password"}
                      onClick={() => setShow(!show)}
                    >
                      {show ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </label>
              )}
              {mfa && (
                <label className="field">
                  <span>Authenticator code</span>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={totp}
                    onChange={(e) => setTotp(e.target.value)}
                    placeholder="000000"
                    required
                    autoFocus
                  />
                </label>
              )}
              {!reset && !forgot && (
                <div className="login-form-options">
                  <span>
                    <ShieldCheck size={14} /> Secure, private session
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setForgot(true);
                      setError(null);
                    }}
                  >
                    Forgot password?
                  </button>
                </div>
              )}
              <Button busy={busy} type="submit" className="login-submit">
                {reset
                  ? "Update password"
                  : forgot
                    ? "Send reset link"
                    : "Sign in to workspace"}
                <ArrowRight size={18} />
              </Button>
              {forgot && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setForgot(false);
                    setSent(false);
                  }}
                >
                  Back to sign in
                </Button>
              )}
            </form>
          )}
          {process.env.NEXT_PUBLIC_DEMO_MODE === "true" &&
            !reset &&
            !forgot && (
              <div className="demo-login">
                <span>ISOLATED DEVELOPMENT WORKSPACE</span>
                <p>
                  Explore real connected workflows with sample data.
                  <br />
                  Not connected to live payments or KRA.
                </p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEmail("owner@duka.test");
                    setPassword("DukaDemo2026!");
                    setMfa(false);
                    setTotp("");
                    setError(null);
                  }}
                >
                  <Store size={16} /> Use demo account
                </Button>
                <p className="form-note">
                  Owner: <code>owner@duka.test</code>
                  <br />
                  Password: <code>DukaDemo2026!</code>
                </p>
              </div>
            )}
          <div className="login-footer">
            <ShieldCheck size={15} /> Your data stays with your business.
          </div>
        </div>
        <span className="login-copyright">
          © {new Date().getFullYear()} Duka Business OS
        </span>
      </section>
    </main>
  );
}
export default function App() {
  const pathname = usePathname(),
    router = useRouter();
  const [actor, setActor] = useState<any>(null),
    [meta, setMeta] = useState<any>(null),
    [booting, setBooting] = useState(true),
    [bootError, setBootError] = useState<any>(null),
    [branch, setBranch] = useState(""),
    [online, setOnline] = useState(true),
    [theme, setTheme] = useState("light"),
    [mobile, setMobile] = useState(false),
    [command, setCommand] = useState(false),
    [help, setHelp] = useState(false),
    [notifications, setNotifications] = useState(false),
    [search, setSearch] = useState(""),
    [toasts, setToasts] = useState<any[]>([]);
  const debounce = useDebounce(search);
  const commandResults = useQuery<any>(
    command && debounce
      ? "/products?limit=5&q=" + encodeURIComponent(debounce)
      : null,
  );
  const low = useQuery<any>(
    actor?.permissions?.includes("inventory.read")
      ? "/inventory/balances?low=true&limit=5"
      : null,
  );
  const notify = useCallback((message: string, type = "success") => {
    const id = crypto.randomUUID();
    setToasts((t) => [...t.slice(-2), { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((v) => v.id !== id)), 6500);
  }, []);
  const reloadMeta = useCallback(async () => {
    const data: any = await api("/metadata");
    setMeta(data);
    setActor(data.actor);
    return data;
  }, []);
  const bootstrap = useCallback(async () => {
    setBootError(null);
    try {
      const me: any = await api("/auth/me");
      setCsrf(me.csrf_token);
      setCommandActor(me.actor.id);
      const m = await reloadMeta();
      const selected =
        localStorage.getItem("duka:branch:" + m.company.id) ?? "";
      setBranch(m.branches.some((b: any) => b.id === selected) ? selected : "");
      return true;
    } catch (e: any) {
      setActor(null);
      setMeta(null);
      if (e.code !== "UNAUTHENTICATED") setBootError(e);
      return false;
    } finally {
      setBooting(false);
    }
  }, [reloadMeta]);
  useEffect(() => {
    bootstrap();
    const connect = () => setOnline(navigator.onLine);
    connect();
    window.addEventListener("online", connect);
    window.addEventListener("offline", connect);
    const expired = () => {
      setActor(null);
      setMeta(null);
      setCsrf("");
    };
    window.addEventListener("duka:session-expired", expired);
    const t = localStorage.getItem("duka:theme") ?? "light";
    setTheme(t);
    document.documentElement.dataset.theme = t;
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    return () => {
      window.removeEventListener("online", connect);
      window.removeEventListener("offline", connect);
      window.removeEventListener("duka:session-expired", expired);
    };
  }, [bootstrap]);
  useEffect(() => {
    setMobile(false);
  }, [pathname]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setCommand((v) => !v);
      }
      if (e.key === "Escape") setMobile(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const changeBranch = (v: string) => {
    setBranch(v);
    localStorage.setItem("duka:branch:" + meta.company.id, v);
  };
  const signOut = async () => {
    if (
      hasUncertainRequests() &&
      !window.confirm(
        "Some commands have unconfirmed responses. Signing out clears their retry recovery keys. Reconcile them with a manager first. Sign out anyway?",
      )
    )
      return;
    const queued = await privateStore<any[]>("queue:" + actor.id).catch(
      () => undefined,
    );
    if (
      queued?.some((q) => q.status !== "posted") &&
      !window.confirm(
        "There are unconfirmed cash captures on this device. Signing out clears this private data permanently. Cancel and synchronize or export the queue first. Sign out anyway?",
      )
    )
      return;
    try {
      await api("/auth/logout", { method: "POST", body: {} });
    } finally {
      setActor(null);
      setMeta(null);
      setCsrf("");
      for (const k of Object.keys(localStorage))
        if (k.startsWith("duka:") && k !== "duka:theme")
          localStorage.removeItem(k);
      clearUncertainRequests();
      indexedDB.deleteDatabase("duka-private");
      navigator.serviceWorker?.controller?.postMessage("CLEAR_PRIVATE_DATA");
      router.push("/");
    }
  };
  const toggleTheme = () => {
    const t = theme === "light" ? "dark" : "light";
    setTheme(t);
    document.documentElement.dataset.theme = t;
    localStorage.setItem("duka:theme", t);
  };
  if (booting)
    return (
      <div className="boot">
        <img src="/icon.svg" width={52} height={52} alt="Duka" />
        <LoaderCircle className="spin" size={20} />
        <span>Opening your workspace…</span>
      </div>
    );
  if (!actor || !meta || pathname === "/reset-password")
    return (
      <>
        {bootError && (
          <div className="login-server-error">
            <ErrorCard
              error={bootError}
              retry={() => {
                setBooting(true);
                bootstrap();
              }}
            />
          </div>
        )}
        <Login onSignedIn={bootstrap} />
      </>
    );
  const visible = navigation.filter((n) =>
    n.permission.split("|").some((p) => actor.permissions.includes(p)),
  );
  const current = navigation.find((n) => n.href === pathname);
  let screen: React.ReactNode;
  const allowed = current
    ? current.permission.split("|").some((p) => actor.permissions.includes(p))
    : true;
  if (!allowed)
    screen = (
      <div className="empty page-empty">
        <ShieldCheck size={40} />
        <h1>Access is restricted</h1>
        <p>
          Your role does not include this workspace. Contact your administrator.
        </p>
        <Link href="/">Return to overview</Link>
      </div>
    );
  else
    switch (pathname) {
      case "/":
        screen = <Dashboard />;
        break;
      case "/setup":
        screen = <SetupPage />;
        break;
      case "/pos":
        screen = <POS />;
        break;
      case "/products":
        screen = <CatalogPage />;
        break;
      case "/customers":
        screen = <ContactsPage kind="customer" />;
        break;
      case "/suppliers":
        screen = <ContactsPage kind="supplier" />;
        break;
      case "/sales":
        screen = <SalesPage />;
        break;
      case "/inventory":
        screen = <InventoryPage />;
        break;
      case "/purchasing":
        screen = <PurchasingPage />;
        break;
      case "/documents":
        screen = <DocumentsPage />;
        break;
      case "/expenses":
        screen = <ExpensesPage />;
        break;
      case "/shifts":
        screen = <ShiftsPage />;
        break;
      case "/accounting":
        screen = <AccountingPage />;
        break;
      case "/reports":
        screen = <ReportsPage />;
        break;
      case "/team":
        screen = <TeamPage />;
        break;
      case "/settings":
        screen = <SettingsPage />;
        break;
      case "/profile":
        screen = <SettingsPage profileOnly />;
        break;
      case "/audit":
        screen = <AuditPage />;
        break;
      case "/integrations":
        screen = <IntegrationsPage />;
        break;
      case "/offline":
        screen = <OfflinePage />;
        break;
      default:
        screen = (
          <div className="empty page-empty">
            <h1>Page not found</h1>
            <Link href="/">Go to overview</Link>
          </div>
        );
    }
  return (
    <WorkspaceContext.Provider
      value={{
        meta,
        actor,
        branch,
        setBranch: changeBranch,
        reloadMeta,
        notify,
        signOut,
        online,
        theme,
        toggleTheme,
      }}
    >
      <div className={`app-layout ${pathname === "/pos" ? "pos-layout" : ""}`}>
        {mobile && (
          <button
            className="sidebar-backdrop"
            aria-label="Close navigation"
            onClick={() => setMobile(false)}
          />
        )}
        <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}>
          <Link href="/" className="brand-link" aria-label="Duka home">
            <Brand />
          </Link>
          <div className="workspace-switch">
            <div className="workspace-mark">{meta.company.name[0]}</div>
            <div>
              <strong>{meta.company.name}</strong>
              <small>Your business workspace</small>
            </div>
            <ChevronDown size={15} />
          </div>
          <nav aria-label="Main navigation">
            {visible.map((n) => (
              <React.Fragment key={n.href}>
                {n.group && <div className="nav-group">{n.group}</div>}
                <Link
                  href={n.href}
                  className={`nav-item ${pathname === n.href ? "active" : ""}`}
                  aria-current={pathname === n.href ? "page" : undefined}
                >
                  <n.icon size={19} />
                  <span>{n.label}</span>
                  {n.href === "/pos" ? (
                    <span className="nav-key">↗</span>
                  ) : null}
                </Link>
              </React.Fragment>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button className="support-link" onClick={() => setHelp(true)}>
              <HelpCircle size={18} />
              <span>Help & quick guide</span>
              <ArrowUpRight size={15} />
            </button>
            <button className="support-link" onClick={signOut}>
              <LogOut size={17} />
              <span>Sign out</span>
            </button>
            <div className="sidebar-status">
              <span className={online ? "status-dot" : "status-dot offline"} />
              {online ? "Workspace connected" : "Offline · local drafts only"}
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
                onClick={() => setMobile(!mobile)}
              >
                <Menu size={22} />
              </button>
              <div className="breadcrumbs">
                <span>Workspace</span>
                <ChevronRight size={14} />
                <strong>
                  {current?.label ??
                    (pathname === "/profile"
                      ? "Account & security"
                      : "Workspace")}
                </strong>
              </div>
            </div>
            <div className="topbar-right">
              <button
                className="global-search"
                onClick={() => setCommand(true)}
              >
                <Search size={17} />
                <span>Search anything…</span>
                <kbd>⌘ K</kbd>
              </button>
              <div className="branch-control">
                <Store size={15} />
                <select
                  aria-label="Active branch"
                  value={branch}
                  onChange={(e) => changeBranch(e.target.value)}
                >
                  <option value="">All branches</option>
                  {meta.branches.map((b: any) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="icon-btn theme-btn"
                aria-label="Toggle color theme"
                onClick={toggleTheme}
              >
                {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
              </button>
              <button
                className="icon-btn notification-btn"
                aria-label="Low stock notifications"
                onClick={() => setNotifications(true)}
              >
                <Bell size={19} />
                {low.data?.total > 0 && <i />}
              </button>
              <button
                className="user-menu"
                title="Account and security"
                aria-label={`Account and security for ${actor.name}`}
                onClick={() => router.push("/profile")}
              >
                <span className="avatar">
                  {actor.name
                    .split(" ")
                    .slice(0, 2)
                    .map((w: string) => w[0])
                    .join("")}
                </span>
                <span>
                  <strong>{actor.name.split(" ")[0]}</strong>
                  <small>
                    {actor.email.includes("owner") ? "Owner" : "My account"}
                  </small>
                </span>
                <ChevronDown size={15} />
              </button>
            </div>
          </header>
          {!online && (
            <div className="offline-banner">
              <WifiOff size={16} /> You’re offline. Carts are local drafts;
              payments, stock and fiscal invoices are not confirmed.
            </div>
          )}
          <main
            className={`page-content ${pathname === "/pos" ? "pos-content" : ""}`}
            key={pathname}
          >
            {screen}
          </main>
          <footer className="app-footer">
            <span>Duka Business OS</span>
            <span>One workspace. Every part of your business.</span>
          </footer>
        </div>
      </div>
      <div className="toasts" aria-live="polite" role="status">
        {toasts.map((t) => (
          <div className={`toast ${t.type}`} key={t.id}>
            {t.type === "success" ? (
              <Check size={18} />
            ) : t.type === "error" ? (
              <X size={18} />
            ) : (
              <HelpCircle size={18} />
            )}
            <span>{t.message}</span>
            <button
              aria-label="Dismiss message"
              onClick={() => setToasts((v) => v.filter((x) => x.id !== t.id))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <Dialog
        open={command}
        onClose={() => setCommand(false)}
        title="Find your next move"
        description="Search your workspace or jump to a product."
      >
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search pages or products…"
        />
        <div className="command-list">
          {visible
            .filter(
              (n) =>
                !search || n.label.toLowerCase().includes(search.toLowerCase()),
            )
            .map((n) => (
              <button
                key={n.href}
                onClick={() => {
                  router.push(n.href);
                  setCommand(false);
                  setSearch("");
                }}
              >
                <n.icon size={19} />
                <span>{n.label}</span>
                <ArrowUpRight size={15} />
              </button>
            ))}
          {commandResults.data?.items?.map((p: any) => (
            <button
              key={p.id}
              onClick={() => {
                router.push("/pos?add=" + p.id);
                setCommand(false);
                setSearch("");
              }}
            >
              <Package size={19} />
              <span>
                {p.name}
                <small>{p.sku}</small>
              </span>
              <ArrowRight size={16} />
            </button>
          ))}
        </div>
      </Dialog>
      <Dialog
        open={notifications}
        onClose={() => setNotifications(false)}
        title="Needs your attention"
        description="Live alerts from your inventory."
      >
        {low.data?.items?.length ? (
          <div className="alert-list">
            {low.data.items.map((p: any) => (
              <Link
                href="/inventory"
                key={p.product_id}
                onClick={() => setNotifications(false)}
              >
                <Package size={21} />
                <div>
                  <strong>{p.name}</strong>
                  <small>
                    {p.quantity} remaining · {p.warehouse}
                  </small>
                </div>
                <ArrowUpRight size={16} />
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty">
            <CheckCheck size={32} />
            <strong>No low-stock alerts in your assigned locations.</strong>
          </div>
        )}
      </Dialog>
      <Dialog
        open={help}
        onClose={() => setHelp(false)}
        title="A connected way to work"
        description="A quick guide to your Duka workspace."
      >
        <div className="guide-list">
          <div>
            <span>01</span>
            <section>
              <h3>Start your shift</h3>
              <p>
                Open a register in Cashier shifts and count your float. Use the
                POS search field for a keyboard barcode scanner.
              </p>
            </section>
          </div>
          <div>
            <span>02</span>
            <section>
              <h3>Sell, receive and reconcile</h3>
              <p>
                Checkout posts tenders, stock and a balanced journal together.
                Cash counts never include mobile money or bank payments.
              </p>
            </section>
          </div>
          <div>
            <span>03</span>
            <section>
              <h3>Correct without erasing history</h3>
              <p>
                Open an invoice to create a capped partial return. Financial
                entries and stock movements stay immutable.
              </p>
            </section>
          </div>
          <div>
            <span>04</span>
            <section>
              <h3>Review the books</h3>
              <p>
                Use Accounting and Reports to reconcile your trial balance,
                inventory ledger, tax and contact statements.
              </p>
            </section>
          </div>
        </div>
        <a
          className="btn secondary"
          href="/api/v1/docs"
          target="_blank"
          rel="noreferrer"
        >
          Open API reference <ArrowUpRight size={16} />
        </a>
      </Dialog>
    </WorkspaceContext.Provider>
  );
}
