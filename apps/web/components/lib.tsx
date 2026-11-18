"use client";
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import { D, money } from "@duka/shared";
export { D, money };
let csrf = "";
let commandActor = "";
export const setCommandActor = (id: string) => {
  commandActor = id;
};
const uncertainKeys = new Map<string, string>();
async function commandKey(path: string, method: string, body: unknown) {
  const bytes = new TextEncoder().encode(
    commandActor +
      ":" +
      method +
      ":" +
      path +
      ":" +
      JSON.stringify(body ?? null),
  );
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  const slot = "duka:request:" + hash;
  let key = uncertainKeys.get(slot);
  try {
    key ??= sessionStorage.getItem(slot) ?? undefined;
  } catch {}
  const prior = !!key;
  key ??= crypto.randomUUID();
  uncertainKeys.set(slot, key);
  try {
    sessionStorage.setItem(slot, key);
  } catch {}
  return {
    key,
    prior,
    clear: () => {
      uncertainKeys.delete(slot);
      try {
        sessionStorage.removeItem(slot);
      } catch {}
    },
  };
}
export const setCsrf = (value: string) => {
  csrf = value;
};
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: any,
    public requestId?: string,
    public status?: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options: {
    method?: string;
    body?: any;
    key?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  const retained =
    !options.key &&
    ["POST", "PUT", "PATCH"].includes(method) &&
    !path.startsWith("/auth/") &&
    path !== "/pos/price"
      ? await commandKey(path, method, options.body)
      : null;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (!["GET", "HEAD"].includes(method)) {
    headers["X-CSRF-Token"] = csrf;
    headers["Idempotency-Key"] =
      options.key ?? retained?.key ?? crypto.randomUUID();
  }
  const uncertainMutation =
    !["GET", "HEAD"].includes(method) &&
    !path.startsWith("/auth/") &&
    path !== "/pos/price";
  const recoveryMessage =
    "Response unconfirmed: this request may already have committed. Do not create a replacement. Retry the exact unchanged form to recover the original result, or reconcile with a manager.";
  let res: Response;
  try {
    res = await fetch("/api/v1" + path, {
      method,
      credentials: "same-origin",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (uncertainMutation && !options.signal?.aborted)
      throw new ApiError("RESPONSE_UNCONFIRMED", recoveryMessage);
    throw error;
  }
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(
      "NETWORK_ERROR",
      uncertainMutation
        ? recoveryMessage
        : "The server returned an unreadable response. Please retry.",
    );
  }
  if (
    res.ok ||
    (!retained?.prior &&
      res.status >= 400 &&
      res.status < 500 &&
      ![401, 429].includes(res.status) &&
      !["TRANSACTION_BUSY", "IDEMPOTENCY_SCOPE_CHANGED"].includes(
        json.error?.code,
      ))
  )
    retained?.clear();
  if (!res.ok) {
    if (
      res.status === 401 &&
      json.error?.code !== "MFA_REQUIRED" &&
      json.error?.code !== "INVALID_CREDENTIALS"
    )
      window.dispatchEvent(new Event("duka:session-expired"));
    throw new ApiError(
      json.error?.code ?? "REQUEST_FAILED",
      uncertainMutation && res.status >= 500
        ? recoveryMessage
        : (json.error?.message ?? "Request failed"),
      json.error?.details,
      json.error?.request_id,
      res.status,
    );
  }
  return json.data as T;
}
export function useQuery<T = any>(url: string | null) {
  type Result = {
    key: string | null;
    data: T | null;
    loading: boolean;
    error: Error | null;
  };
  const [result, setResult] = useState<Result>({
    key: url,
    data: null,
    loading: !!url,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((v) => v + 1), []);
  useEffect(() => {
    if (!url) {
      setResult({ key: null, data: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setResult((old) => ({
      key: url,
      data: old.key === url ? old.data : null,
      loading: true,
      error: null,
    }));
    api<T>(url, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setResult({ key: url, data, loading: false, error: null });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult({ key: url, data: null, loading: false, error });
      });
    return () => controller.abort();
  }, [url, nonce]);
  const current =
    result.key === url ? result : { data: null, loading: !!url, error: null };
  const setData = useCallback(
    (data: T | null) =>
      setResult({ key: url, data, loading: false, error: null }),
    [url],
  );
  return { ...current, refresh, setData };
}
export function draftDecimal(value: any) {
  try {
    const n = D(value || 0);
    return n.isFinite() ? n : D(0);
  } catch {
    return D(0);
  }
}
export function useDebounce<T>(value: T, delay = 250) {
  const [v, set] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => set(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}
export function currency(value: any, c = "KES", compact = false) {
  const d = D(value ?? 0);
  if (compact && d.abs().gte(1000000))
    return (
      (c === "KES" ? "KSh " : c + " ") +
      d.div(1000000).toDecimalPlaces(1).toString() +
      "m"
    );
  const [int, frac] = d.toFixed(2).split(".");
  return (
    (c === "KES" ? "KSh " : c + " ") +
    int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (frac === "00" ? "" : "." + frac)
  );
}
export const number = (v: any) =>
  D(v ?? 0)
    .toDecimalPlaces(3)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export function dateText(value: any, time = false, tz = "Africa/Nairobi") {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-KE", {
    day: "2-digit",
    month: "short",
    year: time ? undefined : "numeric",
    ...(time ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: tz,
  }).format(d);
}
export const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
export function rangeDates(range: string) {
  const to = today();
  const start = new Date(to + "T12:00:00Z");
  if (range === "today") return { from: to, to };
  if (range === "month") return { from: to.slice(0, 8) + "01", to };
  start.setUTCDate(start.getUTCDate() - (range === "7d" ? 6 : 29));
  return { from: start.toISOString().slice(0, 10), to };
}
export interface Workspace {
  meta: any;
  actor: any;
  branch: string;
  setBranch: (v: string) => void;
  reloadMeta: () => Promise<void>;
  notify: (message: string, type?: "success" | "error" | "info") => void;
  signOut: () => Promise<void>;
  online: boolean;
  theme: string;
  toggleTheme: () => void;
}
export const WorkspaceContext = createContext<Workspace>(null as any);
export const useWorkspace = () => useContext(WorkspaceContext);
export function usePermission(p: string) {
  return useWorkspace().actor?.permissions?.includes(p) ?? false;
}
export function scopedQuery(params: Record<string, any>, branch: string) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({
    ...params,
    branch_id: branch || undefined,
  }))
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return q.toString();
}
async function printOverlay(html: string) {
  const overlayId = "duka-print-overlay";
  let overlay = document.getElementById(overlayId);
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = overlayId;
    overlay.setAttribute("aria-hidden", "true");
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = html;
  document.body.classList.add("duka-printing");
  try {
    await new Promise((r) => setTimeout(r, 50));
    window.print();
  } finally {
    document.body.classList.remove("duka-printing");
    overlay.innerHTML = "";
  }
}

export async function printReceipt(receipt: any) {
  const company = receipt.company ?? {};
  const cur = company.currency ?? "KES";
  const width = company.settings?.receiptWidth === 58 ? 58 : 80;
  const confirmed = receipt.fiscal?.status === "successful";
  const cashierName = receipt.cashierName ?? receipt.people?.cashier ?? "";
  const paidMethods = receipt.payments?.map((p: any) => p.method);
  const methodSummary = [...new Set(paidMethods)].join(" + ") || "—";
  const receiptReference = receipt.payments?.find((p: any) => p.reference)
    ?.reference;
  const paidStamp = receipt.created_at ? new Date(receipt.created_at) : null;
  const dateText = receipt.accounting_date
    ? new Date(receipt.accounting_date).toISOString().slice(0, 10)
    : paidStamp ? paidStamp.toISOString().slice(0, 10) : "";
  const timeText = paidStamp
    ? paidStamp.toLocaleTimeString("en-KE", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: company.timezone ?? "Africa/Nairobi",
      })
    : undefined;

  const linesHtml = (receipt.lines ?? [])
    .map(
      (l: any) => `
    <div class="receipt-line">
      <span class="line-name">${escapeHtml(
        l.name ?? l.description ?? l.account ?? l.code ?? "Item",
      )}</span>
      ${
        l.quantity !== undefined && l.unit_price !== undefined
          ? `<span class="line-calc">${escapeHtml(
              String(l.quantity).replace(/\.?0+$/, "") || "0",
            )}${l.unit ? " " + escapeHtml(l.unit) : ""} × ${money(
              l.unit_price,
            )}</span>`
          : l.unit_cost !== undefined
            ? `<span class="line-calc">@ ${money(l.unit_cost)}</span>`
            : ""
      }
      <span class="line-amount">${cur} ${money(
        l.total ?? l.amount ?? l.value ?? l.revenue ?? l.balance ?? 0,
      )}</span>
    </div>
  `,
    )
    .join("");

  const notes = [
    D(receipt.customer_credit_used ?? 0).gt(0)
      ? `Customer account credit: ${receipt.customer_credit_used}`
      : "",
    company.settings?.returnPolicy ?? "",
  ]
    .filter(Boolean)
    .join("\n");

  const kraRows: string[] = [];
  if (receipt.etims_enabled) {
    if (company.tax_pin)
      kraRows.push(
        `<tr><td class="kra-label">Business KRA PIN</td><td class="kra-value">${escapeHtml(company.tax_pin)}</td></tr>`,
      );
    if (confirmed && receipt.fiscal?.fiscal_id)
      kraRows.push(
        `<tr><td class="kra-label">${width > 60 ? "eTIMS CU invoice number" : "eTIMS CU no."}</td><td class="kra-value">${escapeHtml(receipt.fiscal.fiscal_id)}</td></tr>`,
      );
  }

  const html = `
    <div class="receipt-print">
      <div class="receipt-header">
        <div class="company-name">${escapeHtml(company.name ?? "").toUpperCase()}</div>
        ${
          company.address
            ? `<div class="company-line">${escapeHtml(company.address)}</div>`
            : ""
        }
        ${
          company.phone || company.email
            ? `<div class="company-line">${[
                company.phone ? `+254 ${String(company.phone).replace(/^\+?254/, "")}` : null,
                company.email,
              ]
                .filter(Boolean)
                .join(" · ")
              }</div>`
            : ""
        }
        ${
          company.tax_pin && receipt.etims_enabled
            ? `<div class="company-line">Tax PIN: ${escapeHtml(company.tax_pin)}</div>`
            : ""
        }
      </div>
      <div class="receipt-meta">
        <div class="meta-row"><span class="meta-label">Receipt no.</span> <span class="meta-value">${escapeHtml(receipt.number)}</span></div>
        <div class="meta-row"><span class="meta-label">Date</span> <span class="meta-value">${dateText}</span></div>
        ${
          timeText
            ? `<div class="meta-row"><span class="meta-label">Time</span> <span class="meta-value">${timeText}</span></div>`
            : ""
        }
        <div class="meta-row"><span class="meta-label">Served by</span> <span class="meta-value">${escapeHtml(cashierName)}</span></div>
        <div class="meta-row"><span class="meta-label">Payment</span> <span class="meta-value">${escapeHtml(methodSummary)}</span></div>
      </div>
      <hr class="receipt-rule" />
      <div class="receipt-items">
        ${linesHtml}
      </div>
      ${
        receiptReference
          ? `<div class="receipt-row" style="display:flex;justify-content:space-between"><span class="row-label">Reference</span> <span class="row-value">${escapeHtml(receiptReference)}</span></div>`
          : ""
      }
      <hr class="receipt-rule" />
      <div class="receipt-totals">
        <div class="total-row"><span class="total-label">Subtotal</span> <span class="total-value">${cur} ${money(receipt.subtotal ?? 0)}</span></div>
        <div class="total-row"><span class="total-label">Tax</span> <span class="total-value">${cur} ${money(receipt.tax ?? 0)}</span></div>
        ${
          D(receipt.discount ?? 0).gt(0)
            ? `<div class="total-row"><span class="total-label">Discount</span> <span class="total-value">${cur} ${money(receipt.discount)}</span></div>`
            : ""
        }
        <div class="total-row total-bold"><span class="total-label">Total</span> <span class="total-value">${cur} ${money(receipt.total ?? 0)}</span></div>
        <div class="total-row"><span class="total-label">Paid at checkout</span> <span class="total-value">${cur} ${money(receipt.paid_at_sale ?? 0)}</span></div>
        <div class="total-row"><span class="total-label">Balance due</span> <span class="total-value">${cur} ${money(receipt.outstanding ?? 0)}</span></div>
      </div>
      ${
        notes
          ? `<div class="receipt-notes">${escapeHtml(notes)}</div>`
          : ""
      }
      ${
        kraRows.length > 0
          ? `<table class="receipt-kra">${kraRows.join("")}</table>`
          : ""
      }
      <div class="receipt-footer">
        ${escapeHtml(company.settings?.receiptFooter ?? "Thank you for your business!")}
      </div>
      <div class="receipt-footer-small">Please keep this receipt for your records.</div>
    </div>
  `;

  await printOverlay(html);
}

export async function printDocument(kind: string, id: string) {
  const res = await fetch("/api/v1/print/" + kind + "/" + id, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    const e = await res.json().catch(() => null);
    throw new Error(e?.error?.message ?? "Unable to load document for printing.");
  }
  const data: any = await res.json();
  const company = data.company ?? {};
  const cur = company.currency ?? "KES";

  const metaHtml = (data.meta ?? [])
    .map(
      ([label, value]: [string, string]) => `
    <div class="print-meta-row"><span class="print-meta-label">${escapeHtml(String(label))}</span> <span class="print-meta-value">${escapeHtml(String(value))}</span></div>
  `,
    )
    .join("");

  const linesHtml = (data.lines ?? [])
    .map(
      (l: any) => `
    <div class="print-line">
      <span class="print-line-description">${escapeHtml(
        l.description ?? l.name ?? l.account ?? l.code ?? "Item",
      )}</span>
      ${
        l.quantity !== undefined
          ? `<span class="print-line-qty">${escapeHtml(
              String(l.quantity).replace(/\.?0+$/, "") || "0",
            )}${l.unit ? " " + escapeHtml(l.unit) : ""}</span>`
          : ""
      }
      ${
        l.unit_price !== undefined || l.unit_cost !== undefined
          ? `<span class="print-line-unit">${cur} ${money(
              l.unit_price ?? l.unit_cost,
            )}</span>`
          : ""
      }
      <span class="print-line-amount">${cur} ${money(
        l.total ?? l.amount ?? l.value ?? l.balance ?? 0,
      )}</span>
    </div>
  `,
    )
    .join("");

  const totalsHtml = Object.entries(data.totals ?? {})
    .map(
      ([label, value]) => `
    <div class="print-total-row"><span class="print-total-label">${escapeHtml(String(label))}</span> <span class="print-total-value">${cur} ${money(String(value))}</span></div>
  `,
    )
    .join("");

  const partyHtml = data.party
    ? `
    <div class="print-party">
      <div class="print-party-label">${escapeHtml(String(data.party.label ?? "Party"))}</div>
      <div class="print-party-name">${escapeHtml(String(data.party.name ?? ""))}</div>
      ${
        data.party.sub
          ? `<div class="print-party-sub">${escapeHtml(String(data.party.sub))}</div>`
          : ""
      }
    </div>
  `
    : "";

  const referenceHtml = data.reference
    ? `
    <div class="print-reference-row"><span class="print-reference-label">${escapeHtml(String(data.reference.label ?? "Reference"))}</span> <span class="print-reference-value">${escapeHtml(String(data.reference.name ?? ""))}</span></div>
  `
    : "";

  const html = `
    <div class="print-document">
      <div class="print-header">
        <div class="print-title">${escapeHtml(String(data.title))}</div>
        <div class="print-company">${escapeHtml(String(company.name ?? ""))}</div>
        ${
          company.address
            ? `<div class="print-company-line">${escapeHtml(String(company.address))}</div>`
            : ""
        }
      </div>
      <div class="print-meta">
        ${metaHtml}
      </div>
      ${
        data.number
          ? `<div class="print-number-row"><span class="print-number-label">Document no.</span> <span class="print-number-value">${escapeHtml(String(data.number))}</span></div>`
          : ""
      }
      ${
        data.date
          ? `<div class="print-date-row"><span class="print-date-label">Date</span> <span class="print-date-value">${escapeHtml(String(data.date))}</span></div>`
          : ""
      }
      <hr class="print-rule" />
      ${partyHtml}
      ${referenceHtml}
      <hr class="print-rule" />
      <div class="print-items">
        ${linesHtml}
      </div>
      <hr class="print-rule" />
      <div class="print-totals">
        ${totalsHtml}
      </div>
      ${
        data.notes
          ? `<div class="print-notes">${escapeHtml(String(data.notes))}</div>`
          : ""
      }
      <div class="print-footer">
        ${escapeHtml(String(company.settings?.receiptFooter ?? "Thank you for your business!"))}
      </div>
    </div>
  `;

  await printOverlay(html);
}

export async function printStatement(
  kind: "customer" | "supplier",
  id: string,
  q: any,
) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q ?? {}))
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const res = await fetch(
    `/api/v1/${kind === "customer" ? "customers" : "suppliers"}/${id}/statement?${params}`,
    { credentials: "same-origin", cache: "no-store" },
  );
  if (!res.ok) {
    const e = await res.json().catch(() => null);
    throw new Error(e?.error?.message ?? "Unable to load statement for printing.");
  }
  const data: any = await res.json();
  const company = data.company ?? {};
  const cur = company.currency ?? "KES";

  const linesHtml = (data.items ?? [])
    .map(
      (l: any) => `
    <div class="print-statement-line">
      <span class="print-statement-date">${escapeHtml(String(l.accounting_date ?? ""))}</span>
      <span class="print-statement-number">${escapeHtml(String(l.number ?? ""))}</span>
      <span class="print-statement-description">${escapeHtml(String(l.description ?? ""))}</span>
      <span class="print-statement-debit">${
        l.debit !== undefined && l.debit !== "—"
          ? cur + money(String(l.debit))
          : ""
      }</span>
      <span class="print-statement-credit">${
        l.credit !== undefined && l.credit !== "—"
          ? cur + money(String(l.credit))
          : ""
      }</span>
      <span class="print-statement-balance">${cur} ${money(String(l.balance ?? 0))}</span>
    </div>
  `,
    )
    .join("");

  const html = `
    <div class="print-statement">
      <div class="print-header">
        <div class="print-title">${kind === "customer" ? "Customer" : "Supplier"} Statement</div>
        <div class="print-company">${escapeHtml(String(company.name ?? ""))}</div>
        <div class="print-company-line">${escapeHtml(String(data.contact?.name ?? ""))}</div>
        <div class="print-company-line">${escapeHtml(
          String(
            [data.contact?.phone, data.contact?.email]
              .filter(Boolean)
              .join(" · ") || data.contact?.address || "",
          ),
        )}</div>
      </div>
      <div class="print-statement-meta">
        <div class="print-statement-meta-row"><span class="print-statement-meta-label">Statement no.</span> <span class="print-statement-meta-value">${escapeHtml(String(data.contact?.code ?? ""))}</span></div>
        <div class="print-statement-meta-row"><span class="print-statement-meta-label">Period</span> <span class="print-statement-meta-value">${escapeHtml(String(q.from ?? ""))} – ${escapeHtml(String(q.to ?? ""))}</span></div>
        <div class="print-statement-meta-row"><span class="print-statement-meta-label">Date issued</span> <span class="print-statement-meta-value">${new Date().toISOString().slice(0, 10)}</span></div>
      </div>
      <hr class="print-rule" />
      <div class="print-statement-items">
        <div class="print-statement-header">
          <span>Date</span><span>Document</span><span>Details</span><span class="print-statement-right">Debit</span><span class="print-statement-right">Credit</span><span class="print-statement-right">Balance</span>
        </div>
        ${linesHtml}
      </div>
      <hr class="print-rule" />
      <div class="print-totals">
        <div class="print-total-row"><span class="print-total-label">Opening balance</span> <span class="print-total-value">${cur} ${money(String(data.opening ?? 0))}</span></div>
        <div class="print-total-row print-total-bold"><span class="print-total-label">Closing balance</span> <span class="print-total-value">${cur} ${money(String(data.items?.[data.items.length - 1]?.balance ?? data.opening ?? 0))}</span></div>
      </div>
      <div class="print-notes">${escapeHtml(
        `Convention: ${String(data.convention ?? "")}. Balances are ${
          kind === "customer" ? "customer advances/AR" : "supplier advances/AP"
        } control accounts only.`,
      )}</div>
      <div class="print-footer">
        This statement is a statement of account, not a fiscal invoice.
      </div>
    </div>
  `;

  await printOverlay(html);
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export async function download(path: string, filename: string) {
  const res = await fetch("/api/v1" + path, { credentials: "same-origin" });
  if (!res.ok) {
    const e = await res.json();
    throw new Error(e.error?.message ?? "Download failed");
  }
  const blob = await res.blob(),
    url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
export async function privateStore<T = any>(
  key: string,
  value?: any,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("duka-private", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("data");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result,
        tx = db.transaction(
          "data",
          value === undefined ? "readonly" : "readwrite",
        ),
        store = tx.objectStore("data");
      const action =
        value === undefined
          ? store.get(key)
          : value === null
            ? store.delete(key)
            : store.put(value, key);
      let result: any;
      action.onsuccess = () => {
        result = action.result;
      };
      action.onerror = () => reject(action.error);
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
    };
  });
}
export async function updatePrivateStore<T>(
  key: string,
  update: (previous: T | undefined) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("duka-private", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("data");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result,
        tx = db.transaction("data", "readwrite"),
        store = tx.objectStore("data");
      let result: T;
      const get = store.get(key);
      get.onsuccess = () => {
        try {
          result = update(get.result);
          store.put(result, key);
        } catch (e) {
          tx.abort();
          reject(e);
        }
      };
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error("Local queue update was not saved"));
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}
export function hasUncertainRequests() {
  try {
    return (
      uncertainKeys.size > 0 ||
      Object.keys(sessionStorage).some((k) => k.startsWith("duka:request:")) ||
      Object.keys(localStorage).some((k) => k.startsWith("duka:pending:"))
    );
  } catch {
    return uncertainKeys.size > 0;
  }
}
export function clearUncertainRequests() {
  uncertainKeys.clear();
  try {
    for (const k of Object.keys(sessionStorage))
      if (k.startsWith("duka:request:")) sessionStorage.removeItem(k);
  } catch {}
}
export function shortId(id: string) {
  return id?.slice(0, 8) ?? "—";
}
