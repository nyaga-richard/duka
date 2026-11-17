/** Wire-level types for the verified ERP API. Field names follow the ERP's responses. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ErpRequest {
  method: HttpMethod;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  idempotencyKey?: string;
  requestId?: string;
}

export interface ErpResponse<T> {
  status: number;
  data: T;
  requestId: string;
}

export interface ErpTransport {
  request<T = unknown>(request: ErpRequest): Promise<ErpResponse<T>>;
  health(): Promise<{ ok: boolean; live: boolean; ready: boolean; detail?: unknown }>;
  /** Binary download (product images). Optional: a transport may not offer it. */
  download?(path: string): Promise<ErpBinary>;
  close?(): Promise<void>;
  readonly status?: Record<string, unknown>;
}

/** Bytes returned by `GET /api/v1/attachments/:id`. */
export interface ErpBinary {
  bytes: Uint8Array;
  contentType: string;
  filename?: string;
}

/** `GET /api/v1/products/:id/attachments` item. */
export interface ErpAttachment {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
}

/** GET /api/v1/products item (subset used by the sync). */
export interface ErpProduct {
  id: string;
  name: string;
  description: string | null;
  sku: string;
  barcode: string | null;
  category: string | null;
  category_id: string | null;
  parent_id: string | null;
  brand: string | null;
  manufacturer: string | null;
  kind: "stock" | "service" | "bundle";
  price: string;
  min_price: string;
  tax_inclusive: boolean;
  tax_rate: string;
  tax_kind: string;
  unit: string;
  fractional: boolean;
  stock: string;
  reserved: string;
  active: boolean;
  image_attachment_id: string | null;
  updated_at?: string;
}

export interface ErpPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export interface ErpInventoryRow {
  product_id: string;
  product_name?: string;
  sku?: string;
  warehouse_id: string;
  warehouse?: string;
  quantity: string;
  reserved: string;
  available: string;
  value: string;
  version: number;
}

export interface ErpCustomer {
  id: string;
  name: string;
  code: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  tax_pin: string | null;
  credit_limit: string;
  credit_days: number;
  discount_percent: string;
  active: boolean;
}

export interface ErpMetadata {
  company: { id: string; name: string; currency: string; timezone: string; settings: Record<string, unknown> };
  branches: Array<{ id: string; name: string; code: string }>;
  warehouses: Array<{ id: string; name: string; code: string; branch_id: string }>;
  registers: Array<{ id: string; name: string; branch_id: string; warehouse_id: string; active: boolean }>;
  units: Array<{ id: string; name: string; symbol: string }>;
  categories: Array<{ id: string; name: string; parent_id: string | null }>;
  tax_rules: Array<{ id: string; name: string; code: string; rate: string; kind: string }>;
  payment_methods: Array<{ id: string; name: string; kind: string; requires_reference: boolean }>;
  price_lists: Array<{ id: string; name: string }>;
  actor?: { id: string; email: string; permissions?: string[] };
}

export interface ErpSaleSummary {
  id: string;
  number: string;
  total: string;
  status: string;
  customer_id: string | null;
  created_at?: string;
}
