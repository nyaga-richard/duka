"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export interface ToastInput {
  title: string;
  description?: string;
  variant?: "success" | "error";
}

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<{ toast: (input: ToastInput) => void }>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

/**
 * Toaster modelled on shadcn/ui's sonner setup: a fixed live region, transient
 * items, success/error variants. No dependency — one context, one timer each.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((input: ToastInput) => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current.slice(-3), { id, ...input }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 4500);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toaster" role="status" aria-live="polite" aria-atomic="false">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.variant === "error" ? "toast--error" : "toast--success"}`}>
            <span className="spark" aria-hidden="true">
              {item.variant === "error" ? "!" : "✓"}
            </span>
            <div>
              <strong style={{ fontSize: "0.88rem", fontWeight: 600 }}>{item.title}</strong>
              {item.description ? (
                <div className="small muted" style={{ marginTop: "0.1rem" }}>
                  {item.description}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
