/** Shared types, constants and helpers for the store desk (admin). */

export interface OrderRow {
  order_id: number;
  order_number: string;
  status: string;
  payment_status: string;
  order_total: string;
  email: string | null;
  placed_at: string;
  line_count: number;
}

export interface OrderLine {
  order_line_id: number;
  product_name: string;
  sku: string;
  quantity: number;
  unit_price: string;
  line_total: string;
}

export interface OrderPayment {
  amount: string;
  payment_status: string;
  provider_reference: string;
}

export interface Shipment {
  shipment_id: string;
  carrier: string;
  tracking_number: string | null;
  tracking_url: string | null;
  status: string;
  shipped_at: string | null;
  delivered_at: string | null;
}

export interface OrderDetail {
  order_id: number;
  order_number: string;
  status: string;
  payment_status: string;
  totals: { total: string; subtotal: string; shipping: string };
  items: OrderLine[];
  payments: OrderPayment[];
  shipments: Shipment[];
}

export interface AdminProduct {
  product_id: number;
  product_name: string;
  slug: string;
  status: "draft" | "active" | "archived";
  is_featured: boolean;
  sync_state: string | null;
  variants: number;
  active_variants: number;
  category_name: string | null;
  erp_product_id: string | null;
  updated_at: string;
}

export interface AdminVariant {
  variant_id: number;
  product_id: number;
  sku: string;
  price: string;
  compare_at_price: string | null;
  qty_in_stock: number;
  barcode: string | null;
  weight_grams: number | null;
  is_default: boolean;
  is_active: boolean;
  reserved: number;
  available: number;
  options: Array<{ option: string; value: string }>;
  updated_at: string;
}

export interface AdminProductDetail {
  product_id: number;
  product_name: string;
  slug: string;
  summary: string | null;
  description: string | null;
  status: "draft" | "active" | "archived";
  is_featured: boolean;
  brand: string | null;
  brand_name: string | null;
  brand_id: number | null;
  category_id: number | null;
  category_name: string | null;
  sync_state: string | null;
  created_at: string;
  updated_at: string;
  variants: AdminVariant[];
  images: Array<{
    image_id: number;
    image_url: string;
    alt_text: string | null;
    is_primary: boolean;
  }>;
}

export interface Customer {
  customer_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  status: string;
  created_at: string;
  last_login_at: string | null;
  orders: number;
  erp_customer_id: string | null;
}

export interface AuditRow {
  audit_id: number;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  request_id: string | null;
  created_at: string;
}

export interface SyncLog {
  log_id: number;
  entity_type: string;
  direction: string;
  operation: string;
  status: string;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
}

export interface ErpCapability {
  id: string;
  support: string;
  endpoint?: string;
  contract?: string;
}

export interface SyncOverview {
  enabled: boolean;
  jobs: Record<string, number>;
  recent_logs: SyncLog[];
  settings: Record<string, string>;
  capabilities: ErpCapability[];
}

export interface ErpMapping {
  map_id: number;
  entity_type: string;
  local_id: string;
  erp_id: string;
  last_synced_at: string | null;
}

export interface ProbeResult {
  enabled: boolean;
  probed: boolean;
  ok?: boolean;
  identity?: string | null;
  permissions?: string[];
  [key: string]: unknown;
}

export interface StoreSettings {
  settings: Record<string, any>;
  erp: {
    enabled: boolean;
    capabilities_verified: number;
    capabilities_missing: number;
  };
}

export interface Page<T> {
  items: T[];
  page?: number;
  limit?: number;
  total?: number;
}

export type Tab =
  | "orders"
  | "catalogue"
  | "customers"
  | "sync"
  | "activity"
  | "settings";

export const TAB_META: Array<{
  id: Tab;
  label: string;
  group: string;
  description: string;
}> = [
  {
    id: "orders",
    label: "Orders",
    group: "Store",
    description: "Take payment, ship and move orders through fulfilment.",
  },
  {
    id: "catalogue",
    label: "Catalogue",
    group: "Store",
    description:
      "What the storefront publishes. Stock and prices stay ERP-owned.",
  },
  {
    id: "customers",
    label: "Customers",
    group: "Store",
    description: "Registered customers and their ERP mapping.",
  },
  {
    id: "sync",
    label: "ERP sync",
    group: "Operations",
    description:
      "The queue, the capabilities the adapter has verified, and the actions that move data.",
  },
  {
    id: "activity",
    label: "Activity",
    group: "Operations",
    description:
      "Append-only audit trail of every money move and status change made here.",
  },
  {
    id: "settings",
    label: "Settings",
    group: "Operations",
    description:
      "Storefront name and support address, plus the read-only configuration view.",
  },
];

/** Mirrors ALLOWED_TRANSITIONS in the API, so the UI cannot offer a move the
 *  server will reject. Keep the two lists in step. */
export const TRANSITIONS: Record<string, string[]> = {
  placed: ["paid", "payment_failed", "cancelled"],
  payment_failed: ["paid", "cancelled"],
  paid: ["processing", "shipped", "cancelled", "refunded"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered", "refunded"],
  delivered: ["refunded"],
  cancelled: [],
  refunded: [],
};

/** Mirrors the enum accepted by PATCH /admin/shipments/:id. */
export const SHIPMENT_STATUSES = [
  "dispatched",
  "in_transit",
  "delivered",
  "failed",
  "returned",
] as const;

export const CLOSED = new Set(["delivered", "cancelled", "refunded"]);

export const money = (value: string | number) =>
  `KES ${Number(value).toLocaleString("en-KE")}`;

export function tone(status: string): string {
  const value = String(status ?? "").toLowerCase();
  if (
    [
      "paid",
      "fulfilled",
      "delivered",
      "completed",
      "captured",
      "success",
      "succeeded",
      "active",
      "published",
      "verified",
      "supported",
      "ok",
    ].some((word) => value.includes(word))
  )
    return "ok";
  if (
    [
      "cancel",
      "refund",
      "fail",
      "void",
      "archived",
      "rejected",
      "error",
      "missing",
      "unsupported",
    ].some((word) => value.includes(word))
  )
    return "danger";
  if (
    [
      "pending",
      "await",
      "partial",
      "hold",
      "unpaid",
      "draft",
      "queued",
      "running",
      "retry",
      "transit",
      "dispatched",
    ].some((word) => value.includes(word))
  )
    return "warn";
  return "accent";
}

export function when(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });
}

export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 10 ? `${value.slice(0, 8)}…` : value;
}
