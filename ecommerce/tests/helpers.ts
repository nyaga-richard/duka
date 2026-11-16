/**
 * Integration test harness: an isolated embedded PostgreSQL database, the real
 * Express app, a cookie-aware HTTP client and small catalogue fixtures.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { createEmbeddedDatabase, setDatabase, closeDatabase, type Database } from "../apps/api/src/db/index.ts";
import { migrate } from "../apps/api/src/db/migrate.ts";
import { createApp } from "../apps/api/src/app.ts";
import { provisionAdmin } from "../apps/api/src/services/auth.ts";

const ALLOWED_ORIGIN = "http://localhost:3100";

export interface TestContext {
  db: Database;
  server: Server;
  baseUrl: string;
  cleanup: () => Promise<void>;
}

export async function startTestContext(): Promise<TestContext> {
  const dir = await mkdtemp(path.join(tmpdir(), "ecommerce-test-"));
  const db = await createEmbeddedDatabase(path.join(dir, "db"));
  await setDatabase(db);
  await migrate(db);

  const app = createApp({ db });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    db,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDatabase();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface ApiResponse<T = any> {
  status: number;
  body: any;
  headers: Headers;
  data: T;
}

export interface ApiClient {
  cookies: Map<string, string>;
  csrf: string | null;
  request: <T = any>(
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string | undefined>; origin?: string | null },
  ) => Promise<ApiResponse<T>>;
  get: <T = any>(path: string) => Promise<ApiResponse<T>>;
  post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => Promise<ApiResponse<T>>;
  patch: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => Promise<ApiResponse<T>>;
  put: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => Promise<ApiResponse<T>>;
  del: <T = any>(path: string) => Promise<ApiResponse<T>>;
  setCsrfFromBody: (body: any) => void;
}

export function apiClient(baseUrl: string): ApiClient {
  const cookies = new Map<string, string>();
  const client: ApiClient = {
    cookies,
    csrf: null,
    async request<T>(method: string, requestPath: string, options: { body?: unknown; headers?: Record<string, string | undefined>; origin?: string | null } = {}) {
      const headers: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/json",
      };
      const origin = options.origin === undefined ? ALLOWED_ORIGIN : options.origin;
      if (origin) headers.origin = origin;
      if (cookies.size) headers.cookie = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
      if (client.csrf && method !== "GET") headers["x-csrf-token"] = client.csrf;
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        if (value === undefined) delete headers[key];
        else headers[key] = value;
      }
      const response = await fetch(`${baseUrl}${requestPath}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const setCookies = (response.headers as any).getSetCookie?.() ?? [];
      for (const cookie of setCookies as string[]) {
        const [pair] = cookie.split(";");
        const index = pair!.indexOf("=");
        const name = pair!.slice(0, index);
        const value = pair!.slice(index + 1);
        if (!value) cookies.delete(name);
        else cookies.set(name, value);
      }
      const text = await response.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: response.status, body, headers: response.headers, data: body?.data as T };
    },
    get: <T>(requestPath: string) => client.request<T>("GET", requestPath),
    post: <T>(requestPath: string, body?: unknown, headers?: Record<string, string>) =>
      client.request<T>("POST", requestPath, { body, headers }),
    patch: <T>(requestPath: string, body?: unknown, headers?: Record<string, string>) =>
      client.request<T>("PATCH", requestPath, { body, headers }),
    put: <T>(requestPath: string, body?: unknown, headers?: Record<string, string>) =>
      client.request<T>("PUT", requestPath, { body, headers }),
    del: <T>(requestPath: string) => client.request<T>("DELETE", requestPath),
    setCsrfFromBody: (body: any) => {
      client.csrf = body?.csrf_token ?? null;
    },
  };
  return client;
}

export const ORIGIN = ALLOWED_ORIGIN;

export interface CatalogueFixture {
  product_id: number;
  variant_id: number;
  slug: string;
  sku: string;
  price: string;
  stock: number;
  category_id: number;
  brand_id: number;
  option_value_id: number;
  option_id: number;
}

export async function seedCatalogue(
  db: Database,
  input: { name?: string; sku?: string; price?: string; stock?: number; status?: "active" | "draft" } = {},
): Promise<CatalogueFixture> {
  const name = input.name ?? "Kanzu Shirt";
  const sku = input.sku ?? "KANZU-M-BLK";
  const price = input.price ?? "1250.00";
  const stock = input.stock ?? 10;
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${sku.toLowerCase()}`;

  const brand = await db.query<{ brand_id: number }>(
    `INSERT INTO brand(brand_name, slug) VALUES($1,$2)
     ON CONFLICT (brand_name) DO UPDATE SET updated_at = now() RETURNING brand_id`,
    [`Brand ${sku}`, `brand-${sku.toLowerCase()}`],
  );
  const category = await db.query<{ category_id: number }>(
    `INSERT INTO category(category_name, slug) VALUES($1,$2)
     ON CONFLICT (slug) WHERE slug IS NOT NULL DO UPDATE SET updated_at = now() RETURNING category_id`,
    ["Shirts", "shirts"],
  );
  const product = await db.query<{ product_id: number }>(
    `INSERT INTO product(product_name, description, brand, brand_id, slug, status, summary)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING product_id`,
    [name, "A test product", "Duka", brand.rows[0]!.brand_id, slug, input.status ?? "active", "Test product summary"],
  );
  const productId = product.rows[0]!.product_id;
  await db.query("INSERT INTO product_category(product_id, category_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [
    productId,
    category.rows[0]!.category_id,
  ]);
  const option = await db.query<{ option_id: number }>(
    "INSERT INTO product_option(product_id, option_name, sort_order) VALUES($1,'Size',1) RETURNING option_id",
    [productId],
  );
  const optionValue = await db.query<{ option_value_id: number }>(
    "INSERT INTO product_option_value(option_id, value_name, sort_order) VALUES($1,'M',1) RETURNING option_value_id",
    [option.rows[0]!.option_id],
  );
  const variant = await db.query<{ variant_id: number }>(
    `INSERT INTO product_variant(product_id, sku, price, qty_in_stock, is_default, is_active)
     VALUES($1,$2,$3,$4,true,true) RETURNING variant_id`,
    [productId, sku, price, stock],
  );
  await db.query("INSERT INTO variant_option_value(variant_id, option_id, option_value_id) VALUES($1,$2,$3)", [
    variant.rows[0]!.variant_id,
    option.rows[0]!.option_id,
    optionValue.rows[0]!.option_value_id,
  ]);
  await db.query(
    `INSERT INTO product_image(product_id, image_url, alt_text, is_primary) VALUES($1,$2,$3,true)`,
    [productId, `https://cdn.example.test/${slug}.jpg`, name],
  );

  return {
    product_id: productId,
    variant_id: variant.rows[0]!.variant_id,
    slug,
    sku,
    price,
    stock,
    category_id: category.rows[0]!.category_id,
    brand_id: brand.rows[0]!.brand_id,
    option_id: option.rows[0]!.option_id,
    option_value_id: optionValue.rows[0]!.option_value_id,
  };
}

export async function seedAdmin(db: Database, role = "owner", email = "owner@shop.test") {
  return provisionAdmin(db, {
    email,
    password: "OwnerPassword2026!",
    displayName: "Store Owner",
    role,
  });
}

export async function adminClient(baseUrl: string, db: Database, role = "owner", email?: string) {
  const adminEmail = email ?? (role === "owner" ? "owner@shop.test" : `${role}@shop.test`);
  await seedAdmin(db, role, adminEmail);
  const client = apiClient(baseUrl);
  const login = await client.post("/api/v1/admin/auth/login", { email: adminEmail, password: "OwnerPassword2026!" });
  if (login.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(login.body)}`);
  client.setCsrfFromBody(login.data);
  return client;
}

export async function customerClient(baseUrl: string, email = "shopper@example.test") {
  const client = apiClient(baseUrl);
  const register = await client.post("/api/v1/auth/register", {
    email,
    password: "ShopperPassword2026!",
    first_name: "Amina",
    last_name: "Wanjiku",
    phone: "0712345678",
  });
  if (register.status !== 201) throw new Error(`register failed: ${JSON.stringify(register.body)}`);
  client.setCsrfFromBody(register.data);
  return client;
}

export async function guestClient(baseUrl: string, email = "guest@example.test") {
  const client = apiClient(baseUrl);
  const guest = await client.post("/api/v1/auth/guest", { email });
  if (guest.status !== 201) throw new Error(`guest failed: ${JSON.stringify(guest.body)}`);
  client.setCsrfFromBody(guest.data);
  return client;
}

/** Add one item and return the cart view. */
export async function addToCart(client: ApiClient, variantId: number, quantity = 1) {
  return client.post("/api/v1/cart/items", { variant_id: variantId, quantity });
}

export async function checkout(
  client: ApiClient,
  input: { key?: string; shippingMethodId?: number; email?: string } = {},
) {
  return client.post(
    "/api/v1/orders",
    {
      shipping_method_id: input.shippingMethodId ?? 1,
      ship_name: "Amina Wanjiku",
      ship_address_line1: "12 Kenyatta Avenue",
      ship_city: "Nairobi",
      ship_region: "Nairobi County",
      ship_postal_code: "00100",
      ship_country: "Kenya",
      phone: "0712345678",
      email: input.email,
    },
    { "idempotency-key": input.key ?? `test-${Math.random().toString(36).slice(2)}` },
  );
}
