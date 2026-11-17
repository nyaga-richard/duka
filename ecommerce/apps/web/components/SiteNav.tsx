"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  {
    href: "/",
    label: "Shop",
    icon: "store",
    match: (path: string) => path === "/" || path.startsWith("/p/"),
  },
  {
    href: "/cart",
    label: "Cart",
    icon: "bag",
    match: (path: string) => path.startsWith("/cart"),
  },
  {
    href: "/orders",
    label: "Orders",
    icon: "receipt",
    match: (path: string) => path.startsWith("/orders"),
  },
  {
    href: "/admin",
    label: "Staff",
    icon: "receipt",
    match: (path: string) => path.startsWith("/admin"),
  },
] as const;

/**
 * Primary navigation in the topbar. Same `.nav-item` treatment the ERP uses for
 * its sidebar, laid out horizontally: hairline-free text links that take the
 * green wash when active.
 */
export function SiteNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="site-nav" aria-label="Primary">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={link.match(pathname) ? "page" : undefined}
        >
          <span className="label">{link.label}</span>
        </Link>
      ))}
    </nav>
  );
}
