"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live countdown for the stock reservation attached to a cart.
 *
 * The API holds units for a fixed window; showing only a timestamp made people
 * guess how long they had. Once the window passes the timer reports it once so
 * the page can re-read the cart (stock may no longer be held).
 */
export function HoldTimer({
  expiresAt,
  onExpired,
}: {
  expiresAt: string;
  onExpired?: () => void;
}) {
  const target = new Date(expiresAt).getTime();
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, target - Date.now()),
  );

  useEffect(() => {
    setRemaining(Math.max(0, target - Date.now()));
    const id = window.setInterval(() => {
      const left = Math.max(0, target - Date.now());
      setRemaining(left);
      if (left === 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [target]);

  // Fire the callback once, on the transition into "expired".
  const expiredFired = useRef(false);
  useEffect(() => {
    if (remaining > 0 || expiredFired.current) return;
    expiredFired.current = true;
    onExpired?.();
  }, [remaining, onExpired]);

  if (Number.isNaN(target)) return null;

  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  const expired = remaining <= 0;

  return (
    <p
      className="muted tiny"
      style={{ marginTop: 12 }}
      role="status"
      aria-live="polite"
    >
      {expired ? (
        <>
          The stock hold has expired — refresh the cart to check availability.
        </>
      ) : (
        <>
          Stock is held for another{" "}
          <strong style={{ color: "var(--text)" }}>
            {minutes}:{String(seconds).padStart(2, "0")}
          </strong>
          .
        </>
      )}
    </p>
  );
}
