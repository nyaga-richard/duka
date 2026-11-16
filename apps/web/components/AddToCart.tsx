"use client";

import { useState } from "react";
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

  async function add() {
    setState("adding");
    setError(null);
    try {
      await api("/cart/items", { method: "POST", body: { variant_id: variantId, quantity: 1 } });
      setState("added");
    } catch (caught) {
      setState("idle");
      setError(caught instanceof ApiError ? caught.message : "Could not add this item");
    }
  }

  return (
    <div>
      <button onClick={add} disabled={disabled || available <= 0 || state === "adding"}>
        {state === "adding" ? "Adding…" : state === "added" ? "In your cart" : available > 0 ? "Add to cart" : "Sold out"}
      </button>
      {error ? <div className="notice error">{error}</div> : null}
    </div>
  );
}
