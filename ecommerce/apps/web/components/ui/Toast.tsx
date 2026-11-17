"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { AlertIcon, CheckIcon, CloseIcon } from "@/components/icons";

export interface ToastInput {
  title: string;
  description?: string;
  variant?: "success" | "error";
}

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<{ toast: (input: ToastInput) => void }>({
  toast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

/**
 * The ERP's toast, rendered from one fixed `.toasts` live region: same card,
 * same 4.5s life, same green tick. Kept as a context so any client component can
 * announce an outcome without a store.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = Date.now() + Math.random();
      setItems((current) => [...current.slice(-3), { id, ...input }]);
      window.setTimeout(() => dismiss(id), 4500);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="toasts"
        role="status"
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={`toast ${item.variant === "error" ? "error" : "success"}`}
          >
            {item.variant === "error" ? (
              <AlertIcon size={18} />
            ) : (
              <CheckIcon size={18} />
            )}
            <div>
              <strong>{item.title}</strong>
              {item.description ? (
                <div className="muted small">{item.description}</div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss message"
            >
              <CloseIcon size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
