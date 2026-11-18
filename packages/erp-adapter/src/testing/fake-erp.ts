/**
 * Protocol-faithful fake of the Duka ERP HTTP API — TEST ONLY.
 *
 * It emulates the behaviours the adapter must handle, all verified in the ERP
 * source: session cookie + CSRF, Origin allowlist on mutations, Idempotency-Key
 * replay/conflict, page/limit pagination, permission errors, self-approval
 * rejection for sales_order approval, the register/shift precondition on
 * `POST /sales`, rate limiting on login, and failure injection.
 *
 * It contains no production data and refuses to load in production.
 */
import { randomUUID } from "node:crypto";

export interface FakeErpProduct {
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
}

export interface FakeErpState {
  credentials: { email: string; password: string; totp?: string };
  allowedOrigins: string[];
  permissions: string[];
  products: FakeErpProduct[];
  inventory: Array<{
    product_id: string;
    warehouse_id: string;
    quantity: string;
    reserved: string;
    available: string;
    value: string;
    version: number;
  }>;
  customers: Array<{
    id: string;
    name: string;
    code: string;
    email: string | null;
    active: boolean;
  }>;
  documents: Array<{
    id: string;
    number: string;
    status: string;
    kind: string;
    total: string;
  }>;
  sales: Array<{
    id: string;
    number: string;
    total: string;
    status: string;
    customer_id: string | null;
  }>;
  openShifts: Set<string>;
  /** Product image attachments, keyed by ERP product id. */
  attachments: Array<{
    id: string;
    product_id: string;
    filename: string;
    mime_type: string;
    size: number;
    bytes: Uint8Array;
  }>;
  sessions: Map<string, { csrf: string; email: string }>;
  idempotency: Map<string, { body: string; response: unknown; status: number }>;
  failNext: Array<{ status: number; code?: string; message?: string }>;
  loginAttempts: number;
  loginRateLimit: number;
  allowSelfApproval: boolean;
  requests: Array<{
    method: string;
    path: string;
    idempotencyKey?: string;
    origin?: string;
  }>;
}

export interface FakeErp {
  fetch: typeof fetch;
  state: FakeErpState;
  expireSessions: () => void;
  createProduct: (
    overrides: Partial<FakeErpProduct> & {
      sku: string;
      name: string;
      price: string;
    },
  ) => FakeErpProduct;
  /** Attach an image to a product and point its `image_attachment_id` at it. */
  attachImage: (
    productId: string,
    options?: {
      id?: string;
      filename?: string;
      mime_type?: string;
      size?: number;
      bytes?: Uint8Array;
    },
  ) => {
    id: string;
    product_id: string;
    filename: string;
    mime_type: string;
    size: number;
    bytes: Uint8Array;
  };
}

const json = (
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });

const envelope = (data: unknown) => ({
  data,
  meta: { request_id: randomUUID() },
});
const errorBody = (code: string, message: string) => ({
  error: { code, message, request_id: randomUUID() },
});

export function createFakeErp(seed: Partial<FakeErpState> = {}): FakeErp {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The fake ERP transport must never be used in production");
  }

  const state: FakeErpState = {
    credentials: seed.credentials ?? {
      email: "integration@shop.test",
      password: "integration-password-123",
    },
    allowedOrigins: seed.allowedOrigins ?? ["https://erp.example.test"],
    permissions: seed.permissions ?? [
      "catalog.read",
      "inventory.read",
      "customers.read",
      "customers.write",
      "documents.write",
      "sales.read",
      "payments.receive",
    ],
    products: seed.products ?? [],
    inventory: seed.inventory ?? [],
    customers: seed.customers ?? [],
    documents: seed.documents ?? [],
    sales: seed.sales ?? [],
    openShifts: seed.openShifts ?? new Set<string>(),
    attachments: seed.attachments ?? [],
    sessions: new Map(),
    idempotency: new Map(),
    failNext: [],
    loginAttempts: 0,
    loginRateLimit: seed.loginRateLimit ?? 10_000,
    allowSelfApproval: seed.allowSelfApproval ?? false,
    requests: [],
  };

  let counter = 0;
  const nextNumber = (prefix: string) =>
    `${prefix}-${String(++counter).padStart(5, "0")}`;

  const fakeFetch = async (
    input: any,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const headers = new Headers(init.headers as any);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const origin = headers.get("origin") ?? undefined;
    const idempotencyKey = headers.get("idempotency-key") ?? undefined;
    state.requests.push({ method, path, idempotencyKey, origin });

    if (state.failNext.length) {
      const failure = state.failNext.shift()!;
      return json(
        errorBody(
          failure.code ?? "INTERNAL_ERROR",
          failure.message ?? "injected failure",
        ),
        failure.status,
      );
    }

    if (path === "/health/live") return json({ status: "ok" });
    if (path === "/health/ready") return json({ status: "ready" });
    if (path === "/api/v1/openapi.json")
      return json({ openapi: "3.1.0", paths: {} });

    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(method);
    if (isMutation && (!origin || !state.allowedOrigins.includes(origin))) {
      return json(
        errorBody("ORIGIN_DENIED", "Request origin is not allowed"),
        403,
      );
    }

    if (path === "/api/v1/auth/login" && method === "POST") {
      state.loginAttempts += 1;
      if (state.loginAttempts > state.loginRateLimit) {
        return json(errorBody("RATE_LIMITED", "Too many attempts"), 429);
      }
      if (
        body?.email !== state.credentials.email ||
        body?.password !== state.credentials.password
      ) {
        return json(
          errorBody("INVALID_CREDENTIALS", "Invalid email or password"),
          401,
        );
      }
      const token = `session-${randomUUID()}`;
      const csrf = `csrf-${randomUUID()}`;
      state.sessions.set(token, { csrf, email: body.email });
      return json(envelope({ signed_in: true, csrf_token: csrf }), 200, {
        "set-cookie": `duka_session=${token}; Path=/; HttpOnly; SameSite=Lax`,
      });
    }

    const cookie = headers.get("cookie") ?? "";
    const token = cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("duka_session="))
      ?.split("=")[1];
    const session = token ? state.sessions.get(token) : undefined;
    if (!session)
      return json(errorBody("UNAUTHENTICATED", "Please sign in"), 401);
    if (isMutation && headers.get("x-csrf-token") !== session.csrf) {
      return json(
        errorBody("CSRF_INVALID", "Security token is missing or invalid"),
        403,
      );
    }
    if (isMutation && !idempotencyKey) {
      return json(
        errorBody("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required"),
        422,
      );
    }

    if (idempotencyKey) {
      const fingerprint = `${method} ${path} ${JSON.stringify(body ?? null)}`;
      const stored = state.idempotency.get(idempotencyKey);
      if (stored) {
        if (stored.body !== fingerprint) {
          return json(
            errorBody(
              "IDEMPOTENCY_CONFLICT",
              "Idempotency-Key reused with a different payload",
            ),
            409,
          );
        }
        return json(stored.response, stored.status);
      }
    }

    const remember = (response: unknown, status = 200) => {
      if (idempotencyKey) {
        state.idempotency.set(idempotencyKey, {
          body: `${method} ${path} ${JSON.stringify(body ?? null)}`,
          response,
          status,
        });
      }
      return json(response, status);
    };

    if (path === "/api/v1/auth/me" && method === "GET") {
      return json(
        envelope({
          actor: {
            id: "erp-actor-1",
            email: session.email,
            permissions: state.permissions,
          },
        }),
      );
    }

    if (path === "/api/v1/metadata" && method === "GET") {
      return json(
        envelope({
          company: {
            id: "company-1",
            name: "Test ERP",
            currency: "KES",
            timezone: "Africa/Nairobi",
            settings: {},
          },
          branches: [{ id: "branch-1", name: "Nairobi", code: "NBO" }],
          warehouses: [
            {
              id: "warehouse-1",
              name: "Main",
              code: "MAIN",
              branch_id: "branch-1",
            },
          ],
          registers: [
            {
              id: "register-1",
              name: "Till 1",
              branch_id: "branch-1",
              warehouse_id: "warehouse-1",
              active: true,
            },
          ],
          units: [{ id: "unit-1", name: "Piece", symbol: "pc" }],
          categories: [{ id: "category-1", name: "Apparel", parent_id: null }],
          tax_rules: [
            {
              id: "tax-1",
              name: "VAT",
              code: "VAT16",
              rate: "16",
              kind: "standard",
            },
          ],
          payment_methods: [
            {
              id: "method-1",
              name: "M-Pesa",
              kind: "mpesa",
              requires_reference: true,
            },
          ],
          price_lists: [{ id: "list-1", name: "Retail" }],
        }),
      );
    }

    if (path === "/api/v1/products" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const limit = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get("limit") ?? 100)),
      );
      const filtered = state.products.filter(
        (product) =>
          (!q ||
            product.name.toLowerCase().includes(q) ||
            product.sku.toLowerCase().includes(q)) &&
          (url.searchParams.get("active") === "all" || product.active),
      );
      return json(
        envelope({
          items: filtered.slice((page - 1) * limit, page * limit),
          page,
          limit,
          total: filtered.length,
        }),
      );
    }

    if (path === "/api/v1/inventory/balances" && method === "GET") {
      const warehouse = url.searchParams.get("warehouse_id");
      const rows = state.inventory
        .filter((row) => !warehouse || row.warehouse_id === warehouse)
        .map((row) => ({
          ...row,
          product_name: state.products.find((p) => p.id === row.product_id)
            ?.name,
          sku: state.products.find((p) => p.id === row.product_id)?.sku,
        }));
      return json(
        envelope({ items: rows, page: 1, limit: 100, total: rows.length }),
      );
    }

    if (path === "/api/v1/customers" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const rows = state.customers.filter(
        (customer) =>
          !q ||
          customer.email?.toLowerCase() === q ||
          customer.name.toLowerCase().includes(q),
      );
      return json(
        envelope({ items: rows, page: 1, limit: 25, total: rows.length }),
      );
    }

    if (path === "/api/v1/customers" && method === "POST") {
      if (!state.permissions.includes("customers.write")) {
        return json(
          errorBody("FORBIDDEN", "Permission required: customers.write"),
          403,
        );
      }
      if (state.customers.some((customer) => customer.code === body.code)) {
        return json(
          errorBody(
            "DUPLICATE_REFERENCE",
            "A customer with that code already exists",
          ),
          409,
        );
      }
      const customer = {
        id: `erp-customer-${state.customers.length + 1}`,
        name: body.name,
        code: body.code,
        email: body.email || null,
        active: true,
      };
      state.customers.push(customer);
      return remember(envelope(customer), 200);
    }

    const customerMatch = path.match(/^\/api\/v1\/customers\/([^/]+)$/);
    if (customerMatch && method === "PUT") {
      const customer = state.customers.find(
        (entry) => entry.id === customerMatch[1],
      );
      if (!customer)
        return json(errorBody("NOT_FOUND", "Record not found"), 404);
      Object.assign(customer, {
        name: body.name ?? customer.name,
        code: body.code ?? customer.code,
        email: body.email || customer.email,
      });
      return remember(envelope(customer));
    }

    if (path === "/api/v1/documents" && method === "POST") {
      if (body?.kind !== "sales_order") {
        return json(
          errorBody(
            "VALIDATION_ERROR",
            "Only sales orders are supported by this adapter",
          ),
          422,
        );
      }
      const total = (body.lines ?? []).reduce((sum: number, line: any) => {
        const product = state.products.find((p) => p.id === line.product_id);
        return sum + Number(product?.price ?? 0) * Number(line.quantity);
      }, 0);
      const document = {
        id: `erp-document-${state.documents.length + 1}`,
        number: nextNumber("SO"),
        status: "draft",
        kind: "sales_order",
        total: total.toFixed(2),
      };
      state.documents.push(document);
      return remember(envelope(document), 200);
    }

    const transitionMatch = path.match(
      /^\/api\/v1\/documents\/([^/]+)\/transition$/,
    );
    if (transitionMatch && method === "POST") {
      const document = state.documents.find(
        (entry) => entry.id === transitionMatch[1],
      );
      if (!document)
        return json(errorBody("NOT_FOUND", "Record not found"), 404);
      if (body?.status === "approved" && !state.allowSelfApproval) {
        return json(
          errorBody(
            "SELF_APPROVAL",
            "A different authorized user must approve this transaction",
          ),
          403,
        );
      }
      document.status = body?.status ?? document.status;
      return remember(envelope(document));
    }

    if (path === "/api/v1/sales" && method === "POST") {
      if (!state.openShifts.has(body?.register_id)) {
        return json(errorBody("NOT_FOUND", "Record not found"), 404);
      }
      const sale = {
        id: `erp-sale-${state.sales.length + 1}`,
        number: nextNumber("INV"),
        total: (body.payments ?? [])
          .reduce((sum: number, p: any) => sum + Number(p.amount), 0)
          .toFixed(2),
        status: "posted",
        customer_id: body.customer_id ?? null,
      };
      state.sales.push(sale);
      return remember(envelope(sale), 200);
    }

    const saleMatch = path.match(/^\/api\/v1\/sales\/([^/]+)$/);
    if (saleMatch && method === "GET") {
      const sale = state.sales.find((entry) => entry.id === saleMatch[1]);
      if (!sale) return json(errorBody("NOT_FOUND", "Record not found"), 404);
      return json(envelope(sale));
    }

    const attachmentsMatch = path.match(
      /^\/api\/v1\/products\/([^/]+)\/attachments$/,
    );
    if (attachmentsMatch && method === "GET") {
      const productId = decodeURIComponent(attachmentsMatch[1]!);
      if (!state.products.some((product) => product.id === productId)) {
        return json(errorBody("NOT_FOUND", "Record not found"), 404);
      }
      const items = state.attachments
        .filter((entry) => entry.product_id === productId)
        .map(({ id, filename, mime_type, size }) => ({
          id,
          filename,
          mime_type,
          size,
        }));
      return json(envelope({ items }));
    }

    const attachmentMatch = path.match(/^\/api\/v1\/attachments\/([^/]+)$/);
    if (attachmentMatch && method === "GET") {
      const attachment = state.attachments.find(
        (entry) => entry.id === decodeURIComponent(attachmentMatch[1]!),
      );
      if (!attachment)
        return json(errorBody("NOT_FOUND", "Record not found"), 404);
      return new Response(attachment.bytes as unknown as ArrayBuffer, {
        status: 200,
        headers: {
          "content-type": attachment.mime_type,
          "content-disposition": `inline; filename="${attachment.filename}"`,
          "content-length": String(attachment.bytes.byteLength),
        },
      });
    }

    if (path === "/api/v1/customers/settlements" && method === "POST") {
      return remember(
        envelope({ id: `erp-receipt-${randomUUID().slice(0, 8)}` }),
        200,
      );
    }

    if (path === "/api/v1/sales/returns" && method === "POST") {
      return remember(
        envelope({
          id: `erp-return-${randomUUID().slice(0, 8)}`,
          number: nextNumber("CN"),
        }),
        200,
      );
    }

    return json(errorBody("NOT_FOUND", "Endpoint not found"), 404);
  };

  return {
    fetch: fakeFetch as unknown as typeof fetch,
    state,
    expireSessions: () => state.sessions.clear(),
    attachImage: (productId, options = {}) => {
      const size = options.size ?? 12;
      const attachment = {
        id: options.id ?? `erp-attachment-${state.attachments.length + 1}`,
        product_id: productId,
        filename: options.filename ?? "product.png",
        mime_type: options.mime_type ?? "image/png",
        size,
        bytes: options.bytes ?? new Uint8Array(size).fill(7),
      };
      state.attachments.push(attachment);
      const product = state.products.find((entry) => entry.id === productId);
      if (product) product.image_attachment_id = attachment.id;
      return attachment;
    },
    createProduct: (overrides) => {
      const product: FakeErpProduct = {
        id: `erp-product-${state.products.length + 1}`,
        description: null,
        barcode: null,
        category: "Apparel",
        category_id: "category-1",
        parent_id: null,
        brand: "Duka",
        manufacturer: null,
        kind: "stock",
        min_price: "0.00",
        tax_inclusive: true,
        tax_rate: "16",
        tax_kind: "standard",
        unit: "pc",
        fractional: false,
        stock: "0",
        reserved: "0",
        active: true,
        image_attachment_id: null,
        ...overrides,
      };
      state.products.push(product);
      return product;
    },
  };
}
