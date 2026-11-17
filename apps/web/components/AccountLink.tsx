"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { loadIdentity } from "@/lib/api-client";

/**
 * The account entry in the topbar. It has to know whether anyone is signed in,
 * so it reads the session once and again whenever an auth action fires
 * (`auth:changed`), which keeps sign-in, sign-out and registration in sync
 * without a full reload.
 */
export function AccountLink() {
  const pathname = usePathname() ?? "/";
  const [state, setState] = useState<{
    signedIn: boolean;
    name?: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const identity = await loadIdentity();
      setState({
        signedIn: identity?.kind === "customer",
        name: identity?.customer?.first_name ?? undefined,
      });
    } catch {
      setState({ signedIn: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener("auth:changed", onChange);
    return () => window.removeEventListener("auth:changed", onChange);
  }, [refresh]);

  const href = state?.signedIn ? "/account" : "/account/login";
  const active = pathname.startsWith("/account");

  return (
    <Link href={href} aria-current={active ? "page" : undefined}>
      <span className="label">
        {state?.signedIn
          ? state.name
            ? `Hi, ${state.name}`
            : "Account"
          : "Sign in"}
      </span>
    </Link>
  );
}
