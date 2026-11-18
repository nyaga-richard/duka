/**
 * Environment configuration.
 *
 * Rules enforced here (and covered by tests):
 *  - no credential has a usable default;
 *  - production refuses the embedded PGlite driver, insecure cookies and the
 *    test-only payment provider;
 *  - enabling ERP integration requires an explicit base URL and identity;
 *  - secrets never appear in the exported `describe()` output used for logs.
 */
import "dotenv/config";
import { z } from "zod";

const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === ""
    ? fallback
    : ["1", "true", "yes", "on"].includes(value.toLowerCase());

const int = (value: string | undefined, fallback: number) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const environment = z
  .enum(["development", "test", "production"])
  .parse(process.env.NODE_ENV ?? "development");

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required. Copy .env.example to .env and set a value.",
  );
}

const isEmbedded = databaseUrl.startsWith("pglite://");
if (environment === "production" && isEmbedded) {
  throw new Error(
    "Production requires PostgreSQL; the embedded PGlite driver is not allowed",
  );
}
if (
  environment !== "production" &&
  !isEmbedded &&
  !/^postgres(ql)?:\/\//.test(databaseUrl)
) {
  throw new Error(
    "DATABASE_URL must be a postgresql:// URL or pglite://<path> in development",
  );
}

const paymentsMode = z
  .enum(["manual", "disabled", "mpesa", "fake"])
  .parse(process.env.PAYMENTS_MODE ?? "manual");

if (environment === "production" && paymentsMode === "fake") {
  throw new Error(
    "PAYMENTS_MODE=fake is a test provider and cannot run in production",
  );
}

const erpEnabled = bool(process.env.ERP_ENABLED, false);
const erpBaseUrl = process.env.ERP_BASE_URL ?? "";
const erpEmail = process.env.ERP_INTEGRATION_EMAIL ?? "";
const erpPassword = process.env.ERP_INTEGRATION_PASSWORD ?? "";

if (erpEnabled) {
  if (!/^https?:\/\//.test(erpBaseUrl)) {
    throw new Error("ERP_ENABLED requires ERP_BASE_URL (http(s)://…)");
  }
  if (environment === "production" && !erpBaseUrl.startsWith("https://")) {
    throw new Error(
      "Production ERP integration requires ERP_BASE_URL to use https",
    );
  }
  if (!erpEmail || !erpPassword) {
    throw new Error(
      "ERP_ENABLED requires ERP_INTEGRATION_EMAIL and ERP_INTEGRATION_PASSWORD (a dedicated least-privilege ERP identity)",
    );
  }
}

const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const allowedOrigins = list(process.env.ALLOWED_ORIGINS);
if (environment === "production") {
  if (!allowedOrigins.length) {
    throw new Error(
      "ALLOWED_ORIGINS must list the storefront origin in production",
    );
  }
  if (allowedOrigins.some((o) => !o.startsWith("https://"))) {
    throw new Error("Production ALLOWED_ORIGINS must all use https");
  }
  if (!bool(process.env.COOKIE_SECURE, false)) {
    throw new Error("COOKIE_SECURE must be true in production");
  }
  if (erpEnabled && !process.env.ADMIN_BOOTSTRAP_EMAIL) {
    // Not fatal: an admin can be provisioned with the CLI. Surface it at boot.
    process.emitWarning(
      "No ADMIN_BOOTSTRAP_EMAIL configured; provision an admin explicitly",
    );
  }
}

const mpesaMode = z
  .enum(["disabled", "sandbox", "live"])
  .parse(process.env.MPESA_MODE ?? "disabled");

export const config = {
  env: environment,
  isProduction: environment === "production",
  isTest: environment === "test",
  port: int(process.env.PORT, 4100),
  apiPublicUrl:
    process.env.API_PUBLIC_URL ??
    `http://localhost:${int(process.env.PORT, 4100)}`,
  webOrigin,
  allowedOrigins: [...new Set([webOrigin, ...allowedOrigins])],
  trustProxy: int(process.env.TRUST_PROXY, 0),
  cookieSecure: bool(process.env.COOKIE_SECURE, environment === "production"),
  cookieNames: {
    customer: "ecom_session",
    guest: "ecom_guest",
    admin: "ecom_admin_session",
  },
  sessions: {
    customerHours: int(process.env.CUSTOMER_SESSION_HOURS, 24),
    guestHours: int(process.env.GUEST_SESSION_HOURS, 24),
    adminHours: int(process.env.ADMIN_SESSION_HOURS, 8),
  },
  cartReservationMinutes: Math.min(
    Math.max(int(process.env.CART_RESERVATION_MINUTES, 15), 5),
    120,
  ),
  db: {
    url: databaseUrl,
    embedded: isEmbedded,
    poolMax: Math.min(Math.max(int(process.env.DATABASE_POOL_MAX, 10), 1), 50),
    migrationLockId: int(process.env.MIGRATION_LOCK_ID, 918273645),
  },
  erp: {
    enabled: erpEnabled,
    baseUrl: erpBaseUrl.replace(/\/+$/, ""),
    allowedOrigin: process.env.ERP_ALLOWED_ORIGIN ?? "",
    email: erpEmail,
    password: erpPassword,
    totpSecret: process.env.ERP_INTEGRATION_TOTP_SECRET ?? "",
    defaultBranchId: process.env.ERP_DEFAULT_BRANCH_ID ?? "",
    defaultWarehouseId: process.env.ERP_DEFAULT_WAREHOUSE_ID ?? "",
    timeoutMs: int(process.env.ERP_REQUEST_TIMEOUT_MS, 15000),
    maxAttempts: Math.min(Math.max(int(process.env.ERP_MAX_ATTEMPTS, 3), 1), 6),
    reserveOrders: bool(process.env.ERP_RESERVE_ORDERS_IN_ERP, false),
    syncIntervalMs: Math.max(
      int(process.env.ERP_SYNC_INTERVAL_MS, 300000),
      60000,
    ),
  },
  payments: {
    mode: paymentsMode,
    captureEnabled: bool(process.env.PAYMENT_CAPTURE_ENABLED, false),
    mpesa: {
      mode: mpesaMode,
      baseUrl: process.env.MPESA_BASE_URL ?? "",
      consumerKey: process.env.MPESA_CONSUMER_KEY ?? "",
      consumerSecret: process.env.MPESA_CONSUMER_SECRET ?? "",
      shortcode: process.env.MPESA_SHORTCODE ?? "",
      passkey: process.env.MPESA_PASSKEY ?? "",
      callbackSecret: process.env.MPESA_CALLBACK_SECRET ?? "",
      callbackBaseUrl: process.env.MPESA_CALLBACK_BASE_URL ?? "",
    },
  },
  logLevel:
    process.env.LOG_LEVEL ?? (environment === "test" ? "silent" : "info"),
  adminBootstrap: {
    email: process.env.ADMIN_BOOTSTRAP_EMAIL ?? "",
    password: process.env.ADMIN_BOOTSTRAP_PASSWORD ?? "",
  },
} as const;

/** Secret-free view for logs, health payloads and diagnostics. */
export function describeConfig() {
  return {
    env: config.env,
    port: config.port,
    database: {
      driver: config.db.embedded ? "pglite" : "postgres",
      pool_max: config.db.poolMax,
    },
    web_origin: config.webOrigin,
    erp: {
      enabled: config.erp.enabled,
      base_url: config.erp.baseUrl || null,
      reserve_orders: config.erp.reserveOrders,
    },
    payments: {
      mode: config.payments.mode,
      capture_enabled: config.payments.captureEnabled,
    },
  };
}

export type AppConfig = typeof config;
