"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BagIcon } from "@/components/icons";
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

const money = (value: string | number) =>
  `KES ${Number(value).toLocaleString("en-KE")}`;

function monogram(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * The cart drawer: the ERP's cart panel (`cart-line`, `quantity-stepper`,
 * `cart-grand-total`) in a right-hand sheet. /cart stays the place where
 * delivery details are entered; this is for checking what is held and adjusting
 * quantities without leaving the catalogue.
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
        toast({
          title: "Cart unavailable",
          description: caught.message,
          variant: "error",
        });
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
      const next = await api<CartView>(`/cart/items/${variantId}`, {
        method: "PATCH",
        body: { quantity },
      });
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
      <button
        type="button"
        className="btn secondary sm"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Open cart"
      >
        <BagIcon size={16} />
        <span className="label">Cart</span>
        <CartCount />
      </button>

      <Overlay
        open={open}
        onClose={() => setOpen(false)}
        title="Your cart"
        description={
          count
            ? `${count} item${count === 1 ? "" : "s"} held for 15 minutes`
            : undefined
        }
        variant="sheet"
        footer={
          <>
            <div className="cart-grand-total" style={{ marginTop: 0 }}>
              <span>Subtotal</span>
              <strong>{money(cart?.subtotal ?? 0)}</strong>
            </div>
            <Link
              className="btn primary block"
              href="/cart"
              onClick={() => setOpen(false)}
            >
              Checkout
            </Link>
            <button
              type="button"
              className="btn ghost sm block"
              onClick={() => setOpen(false)}
            >
              Continue shopping
            </button>
          </>
        }
      >
        {!cart ? (
          <div className="stack">
            <div className="skeleton" style={{ width: "70%" }} />
            <div className="skeleton" style={{ width: "45%" }} />
            <div className="skeleton tall" style={{ height: "4rem" }} />
          </div>
        ) : cart.items.length === 0 ? (
          <div className="empty" style={{ padding: "2.4rem 1rem" }}>
            <BagIcon size={26} />
            <h3>Nothing here yet</h3>
            <p>Add an item and it will be held while you check out.</p>
            <Link
              className="btn outline sm"
              href="/shop"
              onClick={() => setOpen(false)}
            >
              Browse the shop
            </Link>
          </div>
        ) : (
          <>
            <div className="cart-lines">
              {cart.items.map((line) => (
                <div className="cart-line" key={line.variant_id}>
                  <span className="product-avatar sm" aria-hidden="true">
                    {monogram(line.name)}
                  </span>
                  <div className="cart-line-info">
                    <strong>{line.name}</strong>
                    <div className="muted tiny">
                      {line.options
                        ?.map((option) => option.value)
                        .join(" / ") || line.sku}{" "}
                      · {money(line.unit_price)} each
                    </div>
                    <div className="quantity-stepper">
                      <button
                        type="button"
                        aria-label={`Decrease ${line.name}`}
                        disabled={busy === line.variant_id}
                        onClick={() =>
                          setQuantity(line.variant_id, line.quantity - 1)
                        }
                      >
                        −
                      </button>
                      <span>{line.quantity}</span>
                      <button
                        type="button"
                        aria-label={`Increase ${line.name}`}
                        disabled={
                          busy === line.variant_id ||
                          line.quantity >= line.available
                        }
                        onClick={() =>
                          setQuantity(line.variant_id, line.quantity + 1)
                        }
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <div className="cart-line-end">
                    <span className="price small">
                      {money(line.line_total)}
                    </span>
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busy === line.variant_id}
                      onClick={() => setQuantity(line.variant_id, 0)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {cart.reservation_expires_at ? (
              <p className="muted tiny" style={{ marginTop: 12 }}>
                Stock is held until{" "}
                {new Date(cart.reservation_expires_at).toLocaleTimeString()}.
              </p>
            ) : null}
          </>
        )}
      </Overlay>
    </>
  );
}
