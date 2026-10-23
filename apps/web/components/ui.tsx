"use client";
import React, { useEffect, useRef, useState } from "react";
import {
  X,
  Search,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  PackageOpen,
  Plus,
  Trash2,
  Check,
  ChevronDown,
  AlertCircle,
} from "lucide-react";
import {
  api,
  useDebounce,
  useQuery,
  currency,
  number,
  useWorkspace,
  draftDecimal,
} from "./lib";
export function Button({
  children,
  variant = "primary",
  busy = false,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={`btn ${variant} ${className}`}
      aria-busy={busy}
    >
      {busy ? <LoaderCircle size={16} className="spin" /> : null}
      {children}
    </button>
  );
}
/** Compact stat with an optional icon chip and semantic tone, used by the
 * detail-page headers (products and contacts). */
export function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon?: any;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "default" | "warn";
}) {
  return (
    <div className={"stat-tile" + (tone === "warn" ? " warn" : "")}>
      {Icon ? (
        <span className="stat-icon" aria-hidden>
          <Icon size={16} />
        </span>
      ) : null}
      <span className="stat-body">
        <span className="stat-label">{label}</span>
        <span className="stat-value">{value}</span>
        {sub ? <span className="stat-sub">{sub}</span> : null}
      </span>
    </div>
  );
}
export function Badge({
  children,
  status = "neutral",
}: {
  children: React.ReactNode;
  status?: string;
}) {
  const type = [
    "posted",
    "approved",
    "successful",
    "active",
    "paid",
    "open",
    "available",
  ].includes(status)
    ? "success"
    : [
          "draft",
          "submitted",
          "pending",
          "processing",
          "partial",
          "rejected",
        ].includes(status)
      ? "warning"
      : [
            "failed",
            "conflict",
            "suspended",
            "inactive",
            "cancelled",
            "expired",
          ].includes(status)
        ? "danger"
        : "neutral";
  return <span className={`badge ${type}`}>{children}</span>;
}
export function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
export function ErrorCard({
  error,
  retry,
}: {
  error: any;
  retry?: () => void;
}) {
  return (
    <div role="alert" className="error-card">
      <AlertCircle size={19} />
      <div>
        <strong>{error?.message ?? String(error)}</strong>
        {Array.isArray(error?.details) && (
          <ul>
            {error.details.slice(0, 6).map((d: any, i: number) => (
              <li key={i}>
                {d.path}: {d.message}
              </li>
            ))}
          </ul>
        )}
        {error?.requestId && <small>Reference: {error.requestId}</small>}
      </div>
      {retry && (
        <Button variant="ghost" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  useEffect(() => {
    if (open && !ref.current?.open) {
      ref.current?.showModal();
      document.body.style.overflow = "hidden";
    }
    if (!open && ref.current?.open) ref.current?.close();
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);
  return (
    <dialog
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      ref={ref}
      className={`dialog ${wide ? "wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const rect = ref.current.getBoundingClientRect();
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <button
          className="icon-btn"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      <div className="dialog-content">{children}</div>
    </dialog>
  );
}
export interface Column {
  key: string;
  title: string;
  render?: (row: any) => React.ReactNode;
  align?: "right" | "left";
  className?: string;
}
export function DataTable({
  columns,
  items = [],
  loading = false,
  empty = "No records yet",
  onRow,
}: {
  columns: Column[];
  items?: any[];
  loading?: boolean;
  empty?: string;
  onRow?: (row: any) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`${c.align === "right" ? "right" : ""} ${c.className ?? ""}`}
              >
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 5 }, (_, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key}>
                    <span className="skeleton" />
                  </td>
                ))}
              </tr>
            ))
          ) : items.length ? (
            items.map((r, i) => (
              <tr
                key={r.id ?? i}
                className={onRow ? "clickable" : ""}
                onClick={() => onRow?.(r)}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`${c.align === "right" ? "right" : ""} ${c.className ?? ""}`}
                  >
                    {c.render ? c.render(r) : (r[c.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length}>
                <div className="empty">
                  <PackageOpen size={32} />
                  <strong>{empty}</strong>
                  <span>Your records will appear here when you add them.</span>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
export function Pagination({
  page,
  total,
  limit = 25,
  onChange,
}: {
  page: number;
  total: number;
  limit?: number;
  onChange: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pagination">
      <span>
        {total
          ? `${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total} records`
          : "0 records"}
      </span>
      <div>
        <Button
          variant="ghost"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft size={16} />
        </Button>
        <span>
          {page} / {pages}
        </span>
        <Button
          variant="ghost"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight size={16} />
        </Button>
      </div>
    </div>
  );
}
export function SearchBox({
  value,
  onChange,
  placeholder = "Search records…",
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <label className="search-box">
      <Search size={17} />
      <input
        ref={inputRef}
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button onClick={() => onChange("")} aria-label="Clear search">
          <X size={14} />
        </button>
      )}
    </label>
  );
}
export function FormField({
  label,
  help,
  children,
  required = false,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {required && <b aria-hidden="true"> *</b>}
      </span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}
export type FieldDef = {
  key: string;
  label: string;
  type?: string;
  required?: boolean;
  options?: { id: string; name: string }[];
  default?: any;
  help?: string;
  step?: string;
  min?: string;
  max?: string;
  full?: boolean;
};
export function Fields({
  fields,
  value,
  onChange,
}: {
  fields: FieldDef[];
  value: any;
  onChange: (v: any) => void;
}) {
  return (
    <div className="form-grid">
      {fields.map((f) => (
        <div key={f.key} className={f.full ? "full" : ""}>
          <FormField label={f.label} help={f.help} required={f.required}>
            {f.type === "select" ? (
              <select
                value={value[f.key] ?? ""}
                onChange={(e) =>
                  onChange({ ...value, [f.key]: e.target.value })
                }
                required={f.required}
              >
                <option value="">Select {f.label.toLowerCase()}</option>
                {f.options?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            ) : f.type === "checkbox" ? (
              <span className="check-field">
                <input
                  type="checkbox"
                  checked={!!value[f.key]}
                  onChange={(e) =>
                    onChange({ ...value, [f.key]: e.target.checked })
                  }
                />
                <span>{value[f.key] ? "Enabled" : "Disabled"}</span>
              </span>
            ) : f.type === "textarea" ? (
              <textarea
                rows={3}
                value={value[f.key] ?? ""}
                onChange={(e) =>
                  onChange({ ...value, [f.key]: e.target.value })
                }
                required={f.required}
              />
            ) : (
              <input
                type={f.type ?? "text"}
                value={value[f.key] ?? ""}
                onChange={(e) =>
                  onChange({ ...value, [f.key]: e.target.value })
                }
                required={f.required}
                step={f.step ?? (f.type === "number" ? "0.01" : undefined)}
                min={f.min ?? (f.type === "number" ? "0" : undefined)}
                max={f.max}
                autoComplete={
                  f.type === "password" ? "new-password" : undefined
                }
              />
            )}
          </FormField>
        </div>
      ))}
    </div>
  );
}
export function SearchSelect({
  endpoint,
  label,
  value,
  onChange,
  placeholder = "Search and select…",
  display = "name",
}: {
  endpoint: string;
  label: string;
  value?: any;
  onChange: (row: any) => void;
  placeholder?: string;
  display?: string;
}) {
  const [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0);
  const debounced = useDebounce(query),
    id = React.useId();
  const { data, loading } = useQuery<any>(
    open
      ? endpoint +
          (endpoint.includes("?") ? "&" : "?") +
          "limit=8&q=" +
          encodeURIComponent(debounced)
      : null,
  );
  const rows = data?.items ?? [];
  return (
    <div className="search-select">
      <label htmlFor={id} className="small-label">
        {label}
      </label>
      <div className="search-select-input">
        <Search size={16} />
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={id + "-list"}
          aria-activedescendant={
            open && rows[active] ? id + "-" + active : undefined
          }
          value={open ? query : (value?.[display] ?? "")}
          placeholder={placeholder}
          onFocus={() => {
            setOpen(true);
            setQuery("");
            setActive(0);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 170)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(rows.length - 1, a + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            }
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter" && open) {
              e.preventDefault();
              if (rows[active]) {
                onChange(rows[active]);
                setOpen(false);
                setQuery("");
              }
            }
          }}
        />
        {value && (
          <button
            type="button"
            aria-label={"Clear " + label}
            onClick={() => {
              onChange(null);
              setQuery("");
            }}
          >
            <X size={15} />
          </button>
        )}
        <ChevronDown size={14} />
      </div>
      {open && (
        <div className="select-popover" id={id + "-list"} role="listbox">
          {loading ? (
            <div className="select-option muted">Searching…</div>
          ) : rows.length ? (
            rows.map((r: any, i: number) => (
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                key={r.id}
                id={id + "-" + i}
                className={`select-option ${i === active ? "active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(r);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <span>
                  <strong>{r[display]}</strong>
                  <small>{r.sku ?? r.code ?? r.phone}</small>
                </span>
                {r.price && <b>{currency(r.price)}</b>}
              </button>
            ))
          ) : (
            <div className="select-option muted">No matches found</div>
          )}
        </div>
      )}
    </div>
  );
}
export function ProductAvatar({
  name,
  category,
  small = false,
  imageAttachmentId,
}: {
  name: string;
  category?: string;
  small?: boolean;
  imageAttachmentId?: string | null;
}) {
  if (imageAttachmentId)
    return (
      <img
        className={`product-avatar photo ${small ? "small" : ""}`}
        src={`/api/v1/attachments/${imageAttachmentId}`}
        alt=""
        loading="lazy"
      />
    );
  const colors = ["sage", "ochre", "blue", "rose", "lavender"];
  const n = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  return (
    <span
      className={`product-avatar ${colors[n % 5]} ${small ? "small" : ""}`}
      aria-hidden="true"
    >
      {name
        .split(" ")
        .slice(0, 2)
        .map((w) => w[0])
        .join("")}
    </span>
  );
}
export function LineEditor({
  lines,
  onChange,
  costMode = false,
  stockMode = false,
  outgoing = false,
}: {
  lines: any[];
  onChange: (v: any[]) => void;
  costMode?: boolean;
  stockMode?: boolean;
  outgoing?: boolean;
}) {
  return (
    <div className="line-editor">
      <SearchSelect
        endpoint="/products"
        label="Add an item"
        onChange={(p) => {
          if (p)
            onChange([
              ...lines,
              {
                product_id: p.id,
                product: p,
                quantity: "1",
                unit_cost: p.purchase_cost ?? "0",
                serials: [],
              },
            ]);
        }}
      />
      <div className="edit-lines">
        {lines.map((l, i) => (
          <div className="edit-line" key={i}>
            <div className="line-product">
              <ProductAvatar name={l.product?.name ?? l.name ?? "Item"} small />
              <div>
                <strong>{l.product?.name ?? l.name}</strong>
                <small>{l.product?.sku ?? l.sku}</small>
              </div>
            </div>
            <FormField label="Quantity">
              <input
                aria-label={"Quantity for " + (l.product?.name ?? l.name)}
                inputMode="decimal"
                value={l.quantity}
                onChange={(e) =>
                  onChange(
                    lines.map((x, j) =>
                      j === i ? { ...x, quantity: e.target.value } : x,
                    ),
                  )
                }
                required
              />
            </FormField>
            {costMode && (
              <FormField label="Unit cost">
                <input
                  inputMode="decimal"
                  value={l.unit_cost}
                  onChange={(e) =>
                    onChange(
                      lines.map((x, j) =>
                        j === i ? { ...x, unit_cost: e.target.value } : x,
                      ),
                    )
                  }
                  required
                />
              </FormField>
            )}
            <button
              type="button"
              className="icon-btn danger-text"
              aria-label="Remove line"
              onClick={() => onChange(lines.filter((_, j) => j !== i))}
            >
              <Trash2 size={16} />
            </button>
            {stockMode &&
              !outgoing &&
              draftDecimal(l.quantity).gte(0) &&
              l.product?.batch_tracked && (
                <FormField label="Batch number">
                  <input
                    required
                    value={l.batch_number ?? ""}
                    onChange={(e) =>
                      onChange(
                        lines.map((x, j) =>
                          j === i ? { ...x, batch_number: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </FormField>
              )}
            {stockMode &&
              !outgoing &&
              draftDecimal(l.quantity).gte(0) &&
              l.product?.expiry_tracked && (
                <FormField label="Expiry date">
                  <input
                    type="date"
                    required
                    value={l.expiry_date ?? ""}
                    onChange={(e) =>
                      onChange(
                        lines.map((x, j) =>
                          j === i ? { ...x, expiry_date: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </FormField>
              )}
            {stockMode && l.product?.serial_tracked && (
              <FormField label="Serials (one per line)">
                <textarea
                  value={(l.serials ?? []).join("\n")}
                  onChange={(e) =>
                    onChange(
                      lines.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              serials: e.target.value
                                .split("\n")
                                .filter(Boolean),
                            }
                          : x,
                      ),
                    )
                  }
                />
              </FormField>
            )}
          </div>
        ))}
      </div>
      {!lines.length && (
        <div className="inline-empty">
          Search for a product above to add your first line.
        </div>
      )}
    </div>
  );
}
