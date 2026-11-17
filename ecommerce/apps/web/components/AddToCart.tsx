"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { api, ApiError } from "@/lib/api-client";

export function AddToCart({
  variantId,
  disabled,
  available,
}: {
  variantId: number;
  disabled?: boolean;
  available: number;
}) {
  const [state, setState] = useState<"idle" | "adding" | "added">("idle");
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function add() {
    setState("adding");
    setError(null);
    try {
      await api("/cart/items", {
        method: "POST",
        body: { variant_id: variantId, quantity: 1 },
      });
      setState("added");
      // Let the header counter (and anything else) know without a reload.
      window.dispatchEvent(new Event("cart:updated"));
      toast({
        title: "Added to cart",
        description: "Held for 15 minutes while you check out.",
      });
      window.setTimeout(() => setState("idle"), 2500);
    } catch (caught) {
      setState("idle");
      const message =
        caught instanceof ApiError ? caught.message : "Could not add this item";
      setError(message);
      toast({
        title: "Could not add that item",
        description: message,
        variant: "error",
      });
    }
  }

  const soldOut = available <= 0;

  return (
    <div className="stack">
      <button
        type="button"
        className="btn primary block"
        onClick={add}
        disabled={disabled || soldOut || state === "adding"}
        aria-live="polite"
      >
        {state === "adding"
          ? "Adding…"
          : state === "added"
            ? "Added to cart ✓"
            : soldOut
              ? "Sold out"
              : "Add to cart"}
      </button>
      {error ? <div className="error-card">{error}</div> : null}
    </div>
  );
}
