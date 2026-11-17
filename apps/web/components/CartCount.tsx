"use client";

import { useEffect, useState } from "react";

/**
 * Cart item count in the header. Refreshed on mount and whenever another
 * component announces a cart change (`cart:updated`), so adding an item on the
 * product page updates the header without a reload.
 */
export function CartCount() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/v1/cart", { credentials: "include", cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) setCount(0);
          return;
        }
        const body = await response.json();
        const items: Array<{ quantity?: number }> = body?.data?.items ?? [];
        const total = items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
        if (!cancelled) setCount(Number(body?.data?.item_count ?? total) || 0);
      } catch {
        if (!cancelled) setCount(0);
      }
    }

    void load();
    const onChange = () => void load();
    window.addEventListener("cart:updated", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("cart:updated", onChange);
    };
  }, []);

  if (!count) return null;

  return (
    <span className="cart-count" aria-hidden="true">
      {count > 99 ? "99+" : count}
    </span>
  );
}
