import { tone } from "@/components/admin/types";

/** The ERP's `.badge` with the status tone mapping shared by every screen. */
export function Status({ value }: { value: string }) {
  return (
    <span className={`badge ${tone(value)}`}>
      {String(value ?? "").replace(/[_-]/g, " ")}
    </span>
  );
}

/** `.stat-card` — label, big number, and a one-line footnote. */
export function StatCard({
  label,
  value,
  footnote,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  footnote?: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        {hint}
      </div>
      <strong>{value}</strong>
      {footnote ? (
        <div className="stat-bottom">
          <span>{footnote}</span>
        </div>
      ) : null}
    </div>
  );
}

/** `.card` with the ERP's `.card-heading` (title, note, right-hand action). */
export function Panel({
  title,
  note,
  action,
  children,
  flush = false,
}: {
  title?: string;
  note?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  /** `flush` drops the content padding — used when a table owns the edges. */
  flush?: boolean;
}) {
  return (
    <div className="card">
      {title ? (
        <div className="card-heading">
          <div>
            <h3>{title}</h3>
            {note ? <p>{note}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {flush ? children : <div className="card-content">{children}</div>}
    </div>
  );
}

export function EmptyRow({
  colSpan,
  children,
}: {
  colSpan: number;
  children: React.ReactNode;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="empty-cell">
        {children}
      </td>
    </tr>
  );
}
