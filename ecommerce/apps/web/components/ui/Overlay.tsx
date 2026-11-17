"use client";

import { useEffect, useRef } from "react";
import { CloseIcon } from "@/components/icons";

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** `modal` is the ERP's centred `.dialog`; `sheet` is its right-hand drawer. */
  variant?: "modal" | "sheet";
}

/**
 * Native `<dialog>` in modal mode, so focus trapping, Escape-to-close, inert
 * background and the backdrop come from the platform. The markup matches the
 * ERP's `.dialog` (`heading / content / foot`) and the sheet variant adds the
 * drawer edge.
 */
export function Overlay({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = "modal",
}: OverlayProps) {
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
      className={`dialog ${variant === "sheet" ? "sheet" : ""}`}
      onClose={onClose}
      onClick={(event) => {
        // Clicking the backdrop (the dialog element itself) closes it.
        if (event.target === ref.current) onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-heading">
        <div style={{ minWidth: 0 }}>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="Close"
        >
          <CloseIcon size={17} />
        </button>
      </div>
      <div className="dialog-content">{children}</div>
      {footer ? <div className="dialog-foot">{footer}</div> : null}
    </dialog>
  );
}
