import Link from "next/link";
import { Brand } from "@/components/Brand";
import { CartSheet } from "@/components/CartSheet";
import { SiteNav } from "@/components/SiteNav";
import { ThemeToggle } from "@/components/ThemeToggle";

/**
 * The shop chrome: a 48px translucent nav — wordmark left, links centred,
 * actions right — and a hairline footer, with the shop measure centred inside.
 * Layout only; the apple-inspired skin lives in `app/storefront.css` and is
 * scoped to `.shop-layout`, so staff screens (which render their own shell) are
 * untouched by it.
 */
export default function ShopLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="app-layout shop-layout">
      <div className="app-main">
        <header className="topbar">
          <Link href="/" aria-label="Duka shop home" className="topbar-brand">
            <Brand />
          </Link>
          <SiteNav />
          <div className="topbar-right">
            <CartSheet />
            <ThemeToggle />
          </div>
        </header>
        <div className="shop-main">{children}</div>
        <footer className="app-footer shop-footer">
          <span>Duka Shop · prices and stock come from the Duka ERP</span>
          <span>Payments are collected on delivery in Phase 1</span>
        </footer>
      </div>
    </div>
  );
}
