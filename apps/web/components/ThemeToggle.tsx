"use client";

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "@/components/icons";

type Theme = "light" | "dark";

const STORAGE_KEY = "duka-theme";

function resolved(): Theme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Light/dark switch, the ERP's `.icon-btn.theme-btn` in the topbar. With no
 * stored choice the page follows the operating system; the first click pins an
 * explicit choice for this browser.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(resolved());
  }, []);

  function toggle() {
    const next: Theme = (theme ?? resolved()) === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode: the choice simply will not persist */
    }
    setTheme(next);
  }

  const label =
    theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      className="icon-btn theme-btn"
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      {theme === "dark" ? <SunIcon size={18} /> : <MoonIcon size={18} />}
    </button>
  );
}
