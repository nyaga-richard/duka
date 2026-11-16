import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Duka — shop",
  description: "Duka storefront: catalogue, cart and checkout, synced with the Duka ERP.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <Link className="brand" href="/">Duka</Link>
          <nav>
            <Link href="/">Shop</Link>
            <Link href="/cart">Cart</Link>
            <Link href="/admin">Staff</Link>
          </nav>
        </header>
        {children}
        <footer className="site">
          Prices and stock come from the Duka ERP. Payments are collected manually in Phase 1.
        </footer>
      </body>
    </html>
  );
}
