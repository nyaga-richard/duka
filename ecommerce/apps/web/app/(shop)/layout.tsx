import Link from "next/link";
import { Brand } from "@/components/Brand";
import { CartSheet } from "@/components/CartSheet";
import { SiteNav } from "@/components/SiteNav";
import { ThemeToggle } from "@/components/ThemeToggle";

/**
 * The shop chrome: the ERP's `.topbar` (sticky, hairline, brand on the left,
 * actions on the right) and `.app-footer`, with the catalogue measure centred
 * inside. Staff screens render their own sidebar shell instead — see
 * `/admin`.
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
          <div className="topbar-left">
            <Link href="/" aria-label="Duka shop home" style={{ flex: "none" }}>
              <Brand />
            </Link>
            <SiteNav />
          </div>
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
