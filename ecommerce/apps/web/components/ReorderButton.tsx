"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { OrderView } from "@/components/OrderDetail";

/**
 * Put an old order's lines back in the cart.
 *
 * Lines are added one at a time because the store may have sold out of some of
 * them; a line the API rejects is reported instead of aborting the whole
 * basket, and the customer is sent to the cart once anything landed.
 */
export function ReorderButton({
  items,
  className = "btn primary block",
  label = "Order these again",
}: {
  items: OrderView["items"];
  className?: string;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reorder() {
    setBusy(true);
    setError(null);
    const missed: string[] = [];
    let added = 0;
    for (const item of items) {
      if (!item.variant_id) {
        missed.push(item.product_name);
        continue;
      }
      try {
        await api("/cart/items", {
          method: "POST",
          body: {
            variant_id: item.variant_id,
            quantity: Math.min(Math.max(item.quantity, 1), 20),
          },
        });
        added += 1;
      } catch (caught) {
        missed.push(
          `${item.product_name}${caught instanceof ApiError ? ` (${caught.message})` : ""}`,
        );
      }
    }
    window.dispatchEvent(new Event("cart:updated"));
    setBusy(false);
    if (!missed.length) {
      router.push("/cart");
      return;
    }
    if (added) {
      setError(
        `${added} of ${items.length} lines added. Not available: ${missed.join(", ")}.`,
      );
    } else {
      setError(
        `None of these items are available right now: ${missed.join(", ")}.`,
      );
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <button
        className={className}
        type="button"
        disabled={busy}
        onClick={reorder}
      >
        {busy ? "Adding to cart…" : label}
      </button>
      {error ? <div className="error-card">{error}</div> : null}
    </div>
  );
}
