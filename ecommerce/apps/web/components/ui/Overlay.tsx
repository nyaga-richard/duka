"use client";

import { useEffect, useRef } from "react";

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** `modal` is a centred dialog, `sheet` a right-hand drawer. */
  variant?: "modal" | "sheet";
}

/**
 * Native `<dialog>` in modal mode, so focus trapping, Escape-to-close, inert
 * background and the backdrop come from the platform — the behaviour Radix's
 * Dialog/Sheet provide, without the dependency.
 */
export function Overlay({ open, onClose, title, description, children, footer, variant = "modal" }: OverlayProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={variant === "sheet" ? "sheet" : "modal"}
      onClose={onClose}
      onClick={(event) => {
        // Clicking the backdrop (the dialog element itself) closes it.
        if (event.target === ref.current) onClose();
      }}
      aria-label={title}
    >
      <div className="overlay-head">
        <div style={{ minWidth: 0 }}>
          <h2>{title}</h2>
          {description ? <p className="small muted" style={{ margin: "0.15rem 0 0" }}>{description}</p> : null}
        </div>
        <span style={{ marginLeft: "auto" }} />
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="overlay-body">{children}</div>
      {footer ? <div className="overlay-foot">{footer}</div> : null}
    </dialog>
  );
}
