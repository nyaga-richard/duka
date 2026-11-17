"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CartCount } from "@/components/CartCount";
import { Overlay } from "@/components/ui/Overlay";
import { useToast } from "@/components/ui/Toast";
import { api, ApiError } from "@/lib/api-client";

interface Line {
  variant_id: number;
  name: string;
  sku: string;
  quantity: number;
  unit_price: string;
  line_total: string;
  available: number;
  options?: Array<{ option: string; value: string }>;
}
interface CartView {
  items: Line[];
  item_count: number;
  subtotal: string;
  reservation_expires_at?: string | null;
}

const money = (value: string | number) => `KES ${Number(value).toLocaleString("en-KE")}`;

/**
 * Quick cart drawer in the header (shadcn Sheet pattern). The full page at
 * /cart stays the place where delivery details are entered; this is for
 * checking what is held and adjusting quantities without leaving the catalogue.
 */
export function CartSheet() {
  const [open, setOpen] = useState(false);
  const [cart, setCart] = useState<CartView | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    try {
      setCart(await api<CartView>("/cart"));
    } catch (caught) {
      if (caught instanceof ApiError && caught.status !== 401) {
        toast({ title: "Cart unavailable", description: caught.message, variant: "error" });
      }
      setCart({ items: [], item_count: 0, subtotal: "0.00" });
    }
  }, [toast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function setQuantity(variantId: number, quantity: number) {
    setBusy(variantId);
    try {
      const next = await api<CartView>(`/cart/items/${variantId}`, { method: "PATCH", body: { quantity } });
      setCart(next);
      window.dispatchEvent(new Event("cart:updated"));
      if (quantity === 0) toast({ title: "Removed from cart" });
    } catch (caught) {
      toast({
        title: "Could not update the cart",
        description: caught instanceof ApiError ? caught.message : "Try again",
        variant: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  const count = cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0;

  return (
    <>
      <button type="button" className="cart-link" onClick={() => setOpen(true)} aria-haspopup="dialog">
        Cart
        <CartCount />
      </button>

      <Overlay
        open={open}
        onClose={() => setOpen(false)}
        title="Your cart"
        description={count ? `${count} item${count === 1 ? "" : "s"} held for 15 minutes` : undefined}
        variant="sheet"
        footer={
          <>
            <div className="totals grand" style={{ marginTop: 0 }}>
              <span>Subtotal</span>
              <span className="price">{money(cart?.subtotal ?? 0)}</span>
            </div>
            <Link className="btn btn--lg" href="/cart" onClick={() => setOpen(false)}>
              Checkout
            </Link>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>
              Continue shopping
            </button>
          </>
        }
      >
        {!cart ? (
          <div className="stack">
            <div className="skeleton line" style={{ width: "70%" }} />
            <div className="skeleton line" style={{ width: "45%" }} />
            <div className="skeleton" style={{ height: "4rem" }} />
          </div>
        ) : cart.items.length === 0 ? (
          <div className="empty" style={{ padding: "2rem 1rem" }}>
            <div className="icon" aria-hidden="true">
              🛍
            </div>
            <h3>Nothing here yet</h3>
            <p className="small">Add an item and it will be held while you check out.</p>
            <Link className="btn btn--outline btn--sm" href="/" onClick={() => setOpen(false)}>
              Browse the shop
            </Link>
          </div>
        ) : (
          <>
            {cart.items.map((line) => (
              <div className="sheet-line" key={line.variant_id}>
                <div className="thumb" aria-hidden="true">
                  {line.name
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((word) => word[0]?.toUpperCase() ?? "")
                    .join("")}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "0.9rem", fontWeight: 600 }}>{line.name}</div>
                  <div className="small muted">
                    {line.options?.map((option) => option.value).join(" / ") || line.sku}
                  </div>
                  <div className="stepper" style={{ marginTop: "0.35rem" }}>
                    <button
                      type="button"
                      aria-label={`Decrease ${line.name}`}
                      disabled={busy === line.variant_id}
                      onClick={() => setQuantity(line.variant_id, line.quantity - 1)}
                    >
                      −
                    </button>
                    <span>{line.quantity}</span>
                    <button
                      type="button"
                      aria-label={`Increase ${line.name}`}
                      disabled={busy === line.variant_id || line.quantity >= line.available}
                      onClick={() => setQuantity(line.variant_id, line.quantity + 1)}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="price small" style={{ textAlign: "right" }}>
                  {money(line.line_total)}
                  <div>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      style={{ fontSize: "0.75rem", height: "1.6rem" }}
                      disabled={busy === line.variant_id}
                      onClick={() => setQuantity(line.variant_id, 0)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {cart.reservation_expires_at ? (
              <p className="small muted" style={{ marginTop: "0.75rem" }}>
                Held until {new Date(cart.reservation_expires_at).toLocaleTimeString()}
              </p>
            ) : null}
          </>
        )}
      </Overlay>
    </>
  );
}
