import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { CartCount } from "@/components/CartCount";
import { SearchBar } from "@/components/SearchBar";
import { SiteNav } from "@/components/SiteNav";
import { ThemeToggle } from "@/components/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Duka — shop", template: "%s · Duka" },
  description: "Duka storefront: catalogue, cart and checkout, synced with the Duka ERP.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7fb" },
    { media: "(prefers-color-scheme: dark)", color: "#07090e" },
  ],
};

/* Runs before first paint: an explicit choice wins, otherwise CSS follows the
   OS preference. Kept inline so a dark-mode user never sees a white flash. */
const THEME_SCRIPT = `try{var t=localStorage.getItem("duka-theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <header className="site">
          <Link className="brand" href="/">
            <span className="mark" aria-hidden="true">
              D
            </span>
            Duka
          </Link>
          <SearchBar />
          <span className="spacer" />
          <SiteNav />
          <Link className="cart-link" href="/cart" aria-label="Cart">
            Cart
            <CartCount />
          </Link>
          <ThemeToggle />
        </header>
        {children}
        <footer className="site">
          <div className="wrap">
            <span>Prices and stock come from the Duka ERP. Payments are collected manually in Phase 1.</span>
            <span>© {new Date().getFullYear()} Duka</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
