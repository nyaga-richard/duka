"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Shop", match: (path: string) => path === "/" || path.startsWith("/p/") },
  { href: "/cart", label: "Cart", match: (path: string) => path.startsWith("/cart") },
  { href: "/admin", label: "Staff", match: (path: string) => path.startsWith("/admin") },
];

export function SiteNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="site" aria-label="Primary">
      {LINKS.map((link) => (
        <Link key={link.href} href={link.href} aria-current={link.match(pathname) ? "page" : undefined}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
