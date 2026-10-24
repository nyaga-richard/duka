import { z } from "zod";
import { Decimal } from "decimal.js";
// Deterministic interpreter validation works under nonce CSP without eval probes.
z.config({ jitless: true });
export { Decimal };
Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 40,
});
export const D = (value: Decimal.Value = "0") => new Decimal(value);
export const money = (v: Decimal.Value) => D(v).toDecimalPlaces(2).toFixed(2);
export const qty = (v: Decimal.Value) => D(v).toDecimalPlaces(6).toFixed(6);
export const sum = (values: Decimal.Value[]) =>
  values.reduce<Decimal>((a, b) => a.plus(b), D(0));
export const uuid = z.uuid();
export const amount = z
  .string()
  .regex(
    /^\d{1,16}(\.\d{1,2})?$/,
    "Use a positive decimal string with at most 2 decimal places",
  );
/** Decimal predicates must never throw from a refine: zod runs every check
 * even when an earlier one fails, and decimal.js raises on garbage input —
 * an unwrapped D() turns a bad request into a 500 instead of a 422. */
const decCheck = (fn: (d: Decimal) => boolean) => (v: string) => {
  try {
    return fn(D(v));
  } catch {
    return false;
  }
};
export const quantity = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,6})?$/)
  .refine(
    decCheck((d) => d.gt(0)),
    "Quantity must be positive",
  );
export const signedQuantity = z.string().regex(/^-?\d{1,16}(\.\d{1,6})?$/);
export const cost = z.string().regex(/^\d{1,16}(\.\d{1,6})?$/);
export const date = z.iso.date();
const optionalText = z.string().trim().max(2000).optional();
export const permissions = [
  "dashboard.read",
  "sales.read",
  "sales.create",
  "sales.discount",
  "sales.price_override",
  "sales.below_cost",
  "sales.credit",
  "sales.credit_override",
  "sales.return",
  "sales.refund",
  "catalog.read",
  "catalog.write",
  "inventory.read",
  "inventory.write",
  "inventory.transfer",
  "inventory.count",
  "purchases.read",
  "purchases.create",
  "purchases.approve",
  "purchases.receive",
  "payments.receive",
  "payments.pay",
  "routes.read",
  "routes.manage",
  "routes.shift",
  "shifts.open",
  "shifts.manage",
  "shifts.review",
  "customers.read",
  "customers.write",
  "suppliers.read",
  "suppliers.write",
  "accounting.read",
  "accounting.post",
  "accounting.reverse",
  "accounting.close",
  "expenses.read",
  "expenses.create",
  "expenses.approve",
  "expenses.pay",
  "reports.read",
  "users.manage",
  "settings.manage",
  "audits.read",
  "integrations.manage",
  "offline.manage",
  "documents.write",
] as const;
export const loginSchema = z
  .object({
    email: z.email().transform((v) => v.toLowerCase()),
    password: z.string().min(1).max(256),
    totp: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();
export const productSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: optionalText,
    sku: z.string().trim().min(1).max(80),
    barcode: z.string().trim().max(80).nullable().optional(),
    category_id: uuid.nullable().optional(),
    unit_id: uuid,
    tax_rule_id: uuid,
    supplier_id: uuid.nullable().optional(),
    parent_id: uuid.nullable().optional(),
    kind: z.enum(["stock", "service", "bundle"]).default("stock"),
    brand: optionalText,
    manufacturer: optionalText,
    price: amount,
    purchase_cost: cost.default("0"),
    min_price: amount.default("0"),
    tax_inclusive: z.boolean().default(true),
    reorder_level: cost.default("0"),
    max_stock: cost.nullable().optional(),
    batch_tracked: z.boolean().default(false),
    serial_tracked: z.boolean().default(false),
    expiry_tracked: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .strict()
  .refine((v) => !v.expiry_tracked || v.batch_tracked, {
    message: "Expiry tracking requires batch tracking",
  });
const contactFields = {
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().min(1).max(40),
  email: z.email().or(z.literal("")).optional(),
  phone: optionalText,
  address: optionalText,
  tax_pin: optionalText,
  credit_limit: amount.default("0"),
  credit_days: z.number().int().min(0).max(365).default(30),
  discount_percent: cost.default("0").refine(decCheck((d) => d.lte(100))),
  active: z.boolean().default(true),
};
export const customerSchema = z
  .object({ ...contactFields, route_id: uuid.optional().nullable() })
  .strict();
// Suppliers share the trade terms but never belong to a sales route.
export const supplierSchema = z.object(contactFields).strict();
// Route (van sales) master data: one salesperson and one till per route.
export const routeSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    code: z.string().trim().min(1).max(40),
    salesperson_id: uuid.optional().nullable(),
    register_id: uuid.optional().nullable(),
    active: z.boolean().default(true),
    notes: optionalText,
  })
  .strict();
export const routeShiftOpenSchema = z
  .object({ route_id: uuid, opening_float: amount })
  .strict();
export const cartLineSchema = z
  .object({
    product_id: uuid,
    quantity,
    unit_id: uuid.optional(),
    unit_price: amount.optional(),
    discount_percent: cost
      .optional()
      .refine((v) => v === undefined || decCheck((d) => d.lte(100))(v)),
    batch_id: uuid.optional(),
    serials: z.array(z.string().trim().min(1).max(120)).max(500).default([]),
  })
  .strict();
export const tenderSchema = z
  .object({
    method_id: uuid,
    amount: amount.refine(decCheck((d) => d.gt(0))),
    reference: z.string().trim().min(1).max(100).optional(),
    intent_id: uuid.optional(),
  })
  .strict();
export const checkoutSchema = z
  .object({
    register_id: uuid,
    customer_id: uuid.optional(),
    price_list_id: uuid.optional(),
    order_id: uuid.optional(),
    lines: z.array(cartLineSchema).min(1).max(300),
    discount_percent: cost.default("0").refine(decCheck((d) => d.lte(100))),
    payments: z.array(tenderSchema).max(10),
    customer_credit: amount.default("0"),
    accounting_date: date.optional(),
    notes: optionalText,
    override_reason: z.string().min(5).max(1000).optional(),
    catalog_version: z.string().optional(),
  })
  .strict();
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export const openShiftSchema = z
  .object({ register_id: uuid, opening_float: amount })
  .strict();
export const closeShiftSchema = z
  .object({
    counts: z.record(uuid, amount),
    denominations: z.record(z.string(), z.number().int().min(0)).optional(),
  })
  .strict();
export const stockInputSchema = z
  .object({
    type: z.enum(["opening", "adjustment", "transfer", "count"]),
    warehouse_id: uuid,
    destination_id: uuid.optional(),
    reason: z.string().trim().min(5).max(1000),
    accounting_date: date.optional(),
    lines: z
      .array(
        z
          .object({
            product_id: uuid,
            quantity: signedQuantity,
            unit_cost: cost.optional(),
            batch_id: uuid.optional(),
            batch_number: z.string().min(1).max(120).optional(),
            expiry_date: date.optional(),
            serials: z.array(z.string().min(1).max(120)).max(500).default([]),
            expected_version: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export const poSchema = z
  .object({
    warehouse_id: uuid,
    supplier_id: uuid,
    expected_date: date.optional(),
    notes: optionalText,
    lines: z
      .array(z.object({ product_id: uuid, quantity, unit_cost: cost }).strict())
      .min(1)
      .max(300),
  })
  .strict();
export const grnSchema = z
  .object({
    order_id: uuid,
    reason: optionalText,
    accounting_date: date.optional(),
    lines: z
      .array(
        z
          .object({
            order_line_id: uuid,
            quantity,
            rejected_quantity: cost.default("0"),
            batch_number: z.string().min(1).max(120).optional(),
            expiry_date: date.optional(),
            serials: z.array(z.string().min(1).max(120)).max(500).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(300),
  })
  .strict();
export const supplierInvoiceSchema = z
  .object({
    receipt_id: uuid,
    supplier_reference: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .transform((v) => v.toUpperCase().replace(/\s+/g, " ")),
    due_date: date,
    accounting_date: date.optional(),
    lines: z
      .array(
        z
          .object({ receipt_line_id: uuid, net: amount, tax_rule_id: uuid })
          .strict(),
      )
      .min(1)
      .max(300),
  })
  .strict();
export const settlementSchema = z
  .object({
    contact_id: uuid,
    branch_id: uuid,
    accounting_date: date.optional(),
    payment: tenderSchema,
    allocations: z
      .array(
        z
          .object({
            document_id: uuid,
            document_type: z.enum(["invoice", "opening"]).default("invoice"),
            amount: amount.refine(decCheck((d) => d.gt(0))),
          })
          .strict(),
      )
      .max(300),
    shift_id: uuid.optional(),
  })
  .strict();
export const saleReturnSchema = z
  .object({
    sale_id: uuid,
    reason: z.string().min(5).max(1000),
    accounting_date: date.optional(),
    shift_id: uuid.optional(),
    credit_to_account: z.boolean().default(false),
    pending_refund: z.object({ method_id: uuid, amount }).optional(),
    lines: z
      .array(
        z
          .object({ sale_line_id: uuid, quantity, restock: z.boolean() })
          .strict(),
      )
      .min(1)
      .max(300),
    payments: z.array(tenderSchema).max(10),
  })
  .strict();
export const supplierReturnSchema = z
  .object({
    invoice_id: uuid,
    reason: z.string().min(5).max(1000),
    accounting_date: date.optional(),
    lines: z
      .array(
        z
          .object({
            receipt_line_id: uuid,
            quantity,
            serials: z.array(z.string().min(1).max(120)).max(500).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(300),
  })
  .strict();
export const journalSchema = z
  .object({
    branch_id: uuid,
    accounting_date: date,
    description: z.string().min(5).max(1000),
    reason: z.string().min(5).max(1000),
    lines: z
      .array(
        z
          .object({
            account_id: uuid,
            debit: amount.default("0"),
            credit: amount.default("0"),
            customer_id: uuid.optional(),
            supplier_id: uuid.optional(),
            memo: optionalText,
          })
          .strict(),
      )
      .min(2)
      .max(500),
  })
  .strict();
export const expenseSchema = z
  .object({
    branch_id: uuid,
    category_id: uuid,
    supplier_id: uuid.optional(),
    description: z.string().min(3).max(2000),
    net: amount,
    tax_rule_id: uuid,
    accounting_date: date.optional(),
  })
  .strict();
export const documentSchema = z
  .object({
    kind: z.enum(["quotation", "sales_order", "delivery_note", "requisition"]),
    branch_id: uuid,
    warehouse_id: uuid.optional(),
    customer_id: uuid.optional(),
    supplier_id: uuid.optional(),
    source_id: uuid.optional(),
    sale_id: uuid.optional(),
    notes: optionalText,
    lines: z.array(cartLineSchema).min(1).max(300),
  })
  .strict();
export function calculateLine(input: {
  quantity: Decimal.Value;
  price: Decimal.Value;
  lineDiscount?: Decimal.Value;
  transactionDiscount?: Decimal.Value;
  taxRate: Decimal.Value;
  inclusive: boolean;
}) {
  const q = D(input.quantity),
    p = D(input.price),
    ld = D(input.lineDiscount ?? 0),
    td = D(input.transactionDiscount ?? 0),
    rate = D(input.taxRate);
  if (
    !q.gt(0) ||
    p.lt(0) ||
    ld.lt(0) ||
    ld.gt(100) ||
    td.lt(0) ||
    td.gt(100) ||
    rate.lt(0) ||
    rate.gt(100)
  )
    throw new Error("Invalid pricing input");
  const gross = q.times(p).toDecimalPlaces(2);
  const discounted = gross
    .times(D(1).minus(ld.div(100)))
    .times(D(1).minus(td.div(100)))
    .toDecimalPlaces(2);
  const net = input.inclusive
    ? discounted.div(D(1).plus(rate.div(100))).toDecimalPlaces(2)
    : discounted;
  const tax = input.inclusive
    ? discounted.minus(net)
    : net.times(rate).div(100).toDecimalPlaces(2);
  return {
    net: money(net),
    tax: money(tax),
    total: money(net.plus(tax)),
    discount: money(gross.minus(discounted)),
  };
}
export const transitions: Record<string, Record<string, string[]>> = {
  purchase_order: {
    draft: ["submitted", "cancelled"],
    submitted: ["approved", "rejected", "cancelled"],
    rejected: ["submitted", "cancelled"],
    approved: ["closed", "cancelled"],
    closed: [],
    cancelled: [],
  },
  expense: {
    submitted: ["approved", "rejected"],
    approved: ["posted", "rejected"],
    rejected: [],
    posted: [],
  },
  document: {
    draft: ["submitted", "cancelled"],
    submitted: ["approved", "rejected", "cancelled"],
    approved: ["converted", "cancelled"],
    rejected: [],
    converted: [],
    cancelled: [],
  },
  shift: {
    open: ["submitted"],
    submitted: ["approved", "rejected"],
    rejected: ["submitted"],
    approved: [],
  },
};
export function canTransition(kind: string, from: string, to: string) {
  return transitions[kind]?.[from]?.includes(to) ?? false;
}
export function assertTransition(kind: string, from: string, to: string) {
  if (!canTransition(kind, from, to))
    throw new Error(`Invalid ${kind} transition ${from} → ${to}`);
}
export const defaultRoles: Record<string, readonly string[]> = {
  "Business owner": permissions,
  "General manager": permissions.filter(
    (p) => !["users.manage", "accounting.close"].includes(p),
  ),
  "Branch manager": permissions.filter(
    (p) =>
      ![
        "users.manage",
        "settings.manage",
        "accounting.close",
        "accounting.post",
        "accounting.reverse",
      ].includes(p),
  ),
  Accountant: [
    "dashboard.read",
    "accounting.read",
    "accounting.post",
    "accounting.reverse",
    "accounting.close",
    "reports.read",
    "sales.read",
    "purchases.read",
    "payments.receive",
    "payments.pay",
    "customers.read",
    "suppliers.read",
    "expenses.read",
    "expenses.approve",
    "expenses.pay",
    "shifts.review",
    "audits.read",
  ],
  "Inventory manager": [
    "dashboard.read",
    "catalog.read",
    "catalog.write",
    "inventory.read",
    "inventory.write",
    "inventory.transfer",
    "inventory.count",
    "purchases.read",
    "purchases.receive",
    "reports.read",
  ],
  "Procurement officer": [
    "catalog.read",
    "inventory.read",
    "suppliers.read",
    "suppliers.write",
    "purchases.read",
    "purchases.create",
    "purchases.receive",
    "documents.write",
  ],
  Cashier: [
    "dashboard.read",
    "catalog.read",
    "sales.read",
    "sales.create",
    "sales.credit",
    "shifts.open",
    "customers.read",
    "customers.write",
    "payments.receive",
  ],
  Salesperson: [
    "catalog.read",
    "customers.read",
    "customers.write",
    "sales.read",
    "sales.create",
    "sales.credit",
    "payments.receive",
    "shifts.open",
    "routes.read",
    "routes.shift",
    "documents.write",
  ],
  Auditor: [
    "dashboard.read",
    "accounting.read",
    "reports.read",
    "inventory.read",
    "sales.read",
    "purchases.read",
    "customers.read",
    "suppliers.read",
    "expenses.read",
    "audits.read",
  ],
};

export const openingItemSchema = z
  .object({
    kind: z.enum(["customer", "supplier"]),
    direction: z.enum(["debt", "credit"]).default("debt"),
    contact_id: uuid.optional(),
    contact_code: z.string().trim().min(1).max(40).optional(),
    reference: z.string().trim().min(1).max(120),
    original_date: date.optional(),
    due_date: date,
    amount: amount.refine(decCheck((d) => d.gt(0))),
    description: z.string().max(1000).default(""),
  })
  .strict()
  .refine((x) => !!x.contact_id !== !!x.contact_code, {
    message: "Use one contact ID or account code",
  });
export const openingBatchSchema = z
  .object({
    branch_id: uuid,
    accounting_date: date,
    reference: z.string().trim().min(3).max(160),
    notes: z.string().max(3000).default(""),
    items: z.array(openingItemSchema).min(1).max(500),
  })
  .strict()
  .refine(
    (x) =>
      x.items.every(
        (i) =>
          !i.original_date ||
          (i.original_date <= x.accounting_date &&
            i.due_date >= i.original_date),
      ),
    { message: "Original documents must not follow cutover or their due date" },
  );
