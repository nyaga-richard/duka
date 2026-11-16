/**
 * Shared primitives for the Duka e-commerce project.
 *
 * Money is never represented as a JavaScript float in transport: every decimal
 * crosses the API boundary as a string and is handled with decimal.js. Quantities
 * are integers (whole units) in Phase 1.
 */
import Decimal from "decimal.js";
import { z } from "zod";

export const D = (value: Decimal.Value) => new Decimal(value);

/** Round to 2dp half-up and return a canonical money string. */
export function money(value: Decimal.Value): string {
  return D(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** Convert an arbitrary driver value (string | number | Decimal) to a money string. */
export function toMoney(value: unknown): string {
  if (value === null || value === undefined) return "0.00";
  return money(value as Decimal.Value);
}

export function quantity(value: Decimal.Value): number {
  const n = D(value);
  if (!n.isInteger()) throw new Error("Quantity must be a whole number");
  return n.toNumber();
}

export const MONEY_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/;

export const moneyString = z
  .string()
  .trim()
  .regex(MONEY_PATTERN, "Use a decimal string with at most 2 places, e.g. 1250.00")
  .transform((v) => money(v));

export const positiveMoneyString = moneyString.refine(
  (v) => D(v).gt(0),
  "Amount must be greater than zero",
);

export const nonNegativeInt = z.coerce.number().int().min(0).max(1_000_000);

export const uuid = z.uuid();
export const email = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .transform((v) => v.toLowerCase())
  .pipe(z.email());

export const optionalText = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .transform((v) => (v === "" ? undefined : v));

/** Kenyan MSISDN normalisation: 07xx/01xx/2547xx/+2547xx -> +2547xxxxxxxx. */
export function normalizeKenyanPhone(input: string): string | null {
  const compact = input.replace(/[\s()-]/g, "");
  const m = compact.match(/^(?:\+?254|0)([17]\d{8})$/);
  return m ? `+254${m[1]}` : null;
}

export const kenyanPhone = z
  .string()
  .trim()
  .transform((v) => normalizeKenyanPhone(v))
  .refine((v): v is string => Boolean(v), "Use a Kenyan mobile number, e.g. 0712345678");

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

export const ORDER_STATUS = {
  CART: 1,
  PLACED: 2,
  PAID: 3,
  PROCESSING: 4,
  SHIPPED: 5,
  DELIVERED: 6,
  CANCELLED: 7,
  REFUNDED: 8,
  PAYMENT_FAILED: 9,
} as const;

export type OrderStatusName =
  | "cart"
  | "placed"
  | "paid"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "refunded"
  | "payment_failed";

export const RESERVATION_STATUSES = ["active", "consumed", "released", "expired"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const PERMISSIONS = [
  "orders.read",
  "orders.write",
  "catalog.read",
  "catalog.write",
  "inventory.read",
  "inventory.write",
  "payments.read",
  "payments.write",
  "refunds.write",
  "shipments.write",
  "customers.read",
  "sync.manage",
  "audit.read",
  "settings.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Admin roles shipped with Phase 1. Least privilege by default. */
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: [...PERMISSIONS],
  operations: [
    "orders.read",
    "orders.write",
    "catalog.read",
    "inventory.read",
    "payments.read",
    "refunds.write",
    "shipments.write",
    "customers.read",
    "sync.manage",
  ],
  support: ["orders.read", "customers.read", "catalog.read", "payments.read"],
  auditor: ["orders.read", "payments.read", "audit.read", "inventory.read"],
};

export const MONEY_DECIMAL = Decimal.clone({ rounding: Decimal.ROUND_HALF_UP });
