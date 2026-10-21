import {
  saveOpeningBatch,
  getOpeningBatch,
  listOpeningBatches,
  openingMetadata,
  transitionOpeningBatch,
  postOpeningBatch,
  reverseOpeningBatch,
  applyCreditToOpening,
} from "../services/opening-balances.ts";
import {
  refundExpense,
  reverseExpenseRefund,
  getExpense,
} from "../services/expense-refunds.ts";
import { cancelUncertainCheckout } from "../services/checkout-recovery.ts";
import {
  settleSupplierCredit,
  reverseSupplierCredit,
} from "../services/supplier-credits.ts";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, open as openFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  productSchema,
  customerSchema,
  supplierSchema,
  checkoutSchema,
  openingBatchSchema,
  openShiftSchema,
  closeShiftSchema,
  stockInputSchema,
  poSchema,
  grnSchema,
  supplierInvoiceSchema,
  settlementSchema,
  saleReturnSchema,
  supplierReturnSchema,
  journalSchema,
  expenseSchema,
  documentSchema,
  uuid,
  amount,
  cost,
  quantity,
  date,
  D,
  money,
  sum,
} from "@duka/shared";
import { endpoint, idOf } from "../http.ts";
import {
  one,
  fail,
  requirePermission,
  requireOneOf,
  requireAllBranches,
  has,
  audit,
  branchAccess,
  redactCosts,
  warehouseAccess,
  accountingDate,
  pageArgs,
  uniqueIds,
  type Context,
} from "../db.ts";
import { postJournal, reverseJournal } from "@duka/accounting";
import {
  metadata,
  configureUser,
  setUserAccess,
  configureRole,
  configureCompany,
  listUsers,
  userSchema,
  roleSchema,
  companySchema,
  setupStatus,
} from "../services/admin.ts";
import {
  integrationConfigStatus,
  saveIntegrationConfig,
  setIntegrationEnabled,
} from "../services/integrations-config.ts";
import {
  createProduct,
  updateProduct,
  listProducts,
  saveContact,
  listContacts,
  priceCart,
} from "../services/catalog.ts";
import { checkout, getSale, listSales, returnSale } from "../services/sales.ts";
import {
  openShift,
  closeShift,
  reviewShift,
  expectedShift,
  cashMovement,
} from "../services/shifts.ts";
import {
  settleContact,
  applyAdvance,
  recordPayment,
} from "../services/payments.ts";
import {
  postStockDocument,
  inventoryBalances,
  stockLedger,
  reconcileInventory,
} from "../services/inventory.ts";
import {
  createPurchaseOrder,
  getPurchaseOrder,
  transitionPurchaseOrder,
  receiveGoods,
  getGoodsReceipt,
  recognizeSupplierInvoice,
  returnSupplierGoods,
  listPurchases,
} from "../services/procurement.ts";
import {
  createDocument,
  transitionDocument,
  requisitionToOrder,
  createExpense,
  reviewExpense,
  payExpense,
  acquireAsset,
  depreciateAsset,
  disposeAsset,
  voidExpense,
  reclassifyExpense,
} from "../services/business.ts";
import {
  trialBalance,
  profitAndLoss,
  balanceSheet,
  generalLedger,
  aging,
  contactStatement,
  cashFlow,
  taxSummary,
  inventoryValuation,
  salesAnalysis,
  dashboard,
  csv,
  reportScope,
} from "../services/reports.ts";
import {
  salePdf,
  businessPdf,
  statementPdf,
  reportPdf,
} from "../services/documents.ts";
import {
  changePassword,
  setupMfa,
  enableMfa,
  disableMfa,
  logout,
  clearSessionCookie,
} from "../services/auth.ts";
import {
  createIntent,
  dispatchIntent,
  mockComplete,
  receiveCallback,
  processMpesaEvent,
} from "../integrations/mpesa.ts";
import { verifyIntegrity } from "../services/integrity.ts";
import { retryFiscal } from "../integrations/fiscal.ts";
import { catalogVersion, syncSale } from "../services/offline.ts";
const attachmentPayloadSchema = z
  .object({
    filename: z.string().min(1).max(200),
    mime_type: z.enum(["application/pdf", "image/png", "image/jpeg"]),
    base64: z.string().min(1).max(7000000),
  })
  .strict();
const reason = z.string().trim().min(5).max(1000);
const paymentInput = z
  .object({
    payment: checkoutSchema.shape.payments.element,
    shift_id: uuid.optional(),
    accounting_date: date.optional(),
  })
  .strict();
async function pageQuery(ctx: Context, sql: string, params: unknown[], q: any) {
  const { page, limit, offset } = pageArgs(q);
  const r = await ctx.db.query(
    sql + ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return {
    items: r.rows.map(({ _count, ...r }) => r),
    page,
    limit,
    total: r.rows[0]?._count ?? 0,
  };
}
endpoint(
  "get",
  "/auth/me",
  undefined,
  undefined,
  "Current server-side identity and security token",
  async (ctx) => ({
    actor: { ...ctx.actor, csrf_token: undefined },
    csrf_token: ctx.actor.csrf_token,
    company: await one(
      ctx,
      "SELECT id,name,currency,timezone FROM companies WHERE id=$1",
      [ctx.companyId],
    ),
  }),
);
endpoint(
  "post",
  "/auth/logout",
  undefined,
  undefined,
  "Revoke current session",
  async (ctx, _i, req) => {
    await logout(ctx.actor);
    return { signed_out: true };
  },
  { idempotent: false, clearSession: true },
);
endpoint(
  "post",
  "/auth/change-password",
  undefined,
  z
    .object({
      current_password: z.string().max(256),
      new_password: z.string().min(12).max(256),
    })
    .strict(),
  "Change password and revoke sessions",
  async (ctx, i) => {
    await changePassword(ctx, i.current_password, i.new_password);
    return { changed: true };
  },
  { idempotent: false, clearSession: true },
);
endpoint(
  "post",
  "/auth/mfa/setup",
  undefined,
  z.object({ password: z.string().max(256) }).strict(),
  "Provision TOTP after password verification",
  (ctx, i) => setupMfa(ctx, i.password),
  { idempotent: false },
);
endpoint(
  "post",
  "/auth/mfa/enable",
  undefined,
  z.object({ code: z.string().regex(/^\d{6}$/) }).strict(),
  "Enable authenticator MFA",
  async (ctx, i) => {
    await enableMfa(ctx, i.code);
    return { enabled: true };
  },
  { idempotent: false },
);
endpoint(
  "post",
  "/auth/mfa/disable",
  undefined,
  z
    .object({
      password: z.string().max(256),
      code: z.string().regex(/^\d{6}$/),
    })
    .strict(),
  "Disable MFA with password and current code",
  async (ctx, i) => {
    await disableMfa(ctx, i.password, i.code);
    return { enabled: false };
  },
  { idempotent: false },
);
endpoint(
  "get",
  "/auth/sessions",
  undefined,
  undefined,
  "List own sessions",
  async (ctx) => ({
    items: (
      await ctx.db.query(
        "SELECT id,created_at,expires_at,revoked_at,ip,user_agent FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
        [ctx.actor.id],
      )
    ).rows,
  }),
);
endpoint(
  "post",
  "/auth/sessions/:id/revoke",
  undefined,
  undefined,
  "Revoke an owned session",
  async (ctx, _i, req) => {
    const r = await ctx.db.query(
      "UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 RETURNING id",
      [idOf(req), ctx.actor.id],
    );
    if (!r.rowCount) fail(404, "NOT_FOUND", "Session not found");
    await audit(ctx, "session.revoke", "user", ctx.actor.id);
    return { revoked: true };
  },
);
endpoint(
  "get",
  "/metadata",
  undefined,
  undefined,
  "Authorized organization and catalog configuration",
  metadata,
);
endpoint(
  "get",
  "/dashboard",
  "dashboard.read",
  undefined,
  "Authoritative branch dashboard",
  (ctx, q) => dashboard(ctx, q),
);
endpoint(
  "get",
  "/products",
  "catalog.read",
  undefined,
  "Search paginated catalog and barcode aliases",
  listProducts,
);
endpoint(
  "post",
  "/products",
  "catalog.write",
  productSchema,
  "Create a product",
  createProduct,
);
endpoint(
  "put",
  "/products/:id",
  "catalog.write",
  productSchema,
  "Update product with immutable history guards",
  (ctx, i, req) => updateProduct(ctx, idOf(req), i),
);
endpoint(
  "get",
  "/products/:id",
  "catalog.read",
  undefined,
  "Product details and units",
  async (ctx, _q, req) => {
    const p = await one(
      ctx,
      "SELECT * FROM products WHERE company_id=$1 AND id=$2",
      [ctx.companyId, idOf(req)],
    );
    return {
      ...redactCosts(ctx, p),
      units: (
        await ctx.db.query(
          "SELECT pu.*,u.name,u.symbol FROM product_units pu JOIN units u ON u.company_id=pu.company_id AND u.id=pu.unit_id WHERE pu.company_id=$1 AND product_id=$2",
          [ctx.companyId, p.id],
        )
      ).rows,
      barcodes: (
        await ctx.db.query(
          "SELECT barcode FROM product_barcodes WHERE company_id=$1 AND product_id=$2",
          [ctx.companyId, p.id],
        )
      ).rows,
      components: (
        await ctx.db.query(
          "SELECT bc.*,p.name FROM bundle_components bc JOIN products p ON p.company_id=bc.company_id AND p.id=bc.product_id WHERE bc.company_id=$1 AND bundle_id=$2",
          [ctx.companyId, p.id],
        )
      ).rows,
    };
  },
);
endpoint(
  "post",
  "/products/:id/units",
  "catalog.write",
  z.object({ unit_id: uuid, factor: quantity }).strict(),
  "Configure a selling or purchase unit conversion",
  async (ctx, i, req) => {
    const p = await one(
      ctx,
      "SELECT * FROM products WHERE company_id=$1 AND id=$2",
      [ctx.companyId, idOf(req)],
    );
    if (p.unit_id === i.unit_id)
      fail(422, "BASE_UNIT", "Base unit always has a factor of one");
    await one(ctx, "SELECT id FROM units WHERE company_id=$1 AND id=$2", [
      ctx.companyId,
      i.unit_id,
    ]);
    await ctx.db.query(
      "INSERT INTO product_units(company_id,product_id,unit_id,factor) VALUES($1,$2,$3,$4) ON CONFLICT(company_id,product_id,unit_id) DO UPDATE SET factor=EXCLUDED.factor",
      [ctx.companyId, p.id, i.unit_id, i.factor],
    );
    await audit(ctx, "unit_conversion", "product", p.id, null, i);
    return i;
  },
);
endpoint(
  "post",
  "/products/:id/barcodes",
  "catalog.write",
  z.object({ barcode: z.string().trim().min(1).max(80) }).strict(),
  "Add an additional unique barcode",
  async (ctx, i, req) => {
    await one(ctx, "SELECT id FROM products WHERE company_id=$1 AND id=$2", [
      ctx.companyId,
      idOf(req),
    ]);
    await ctx.db.query(
      "INSERT INTO product_barcodes(company_id,product_id,barcode) VALUES($1,$2,$3)",
      [ctx.companyId, idOf(req), i.barcode],
    );
    await audit(ctx, "barcode.add", "product", idOf(req), null, i);
    return i;
  },
);
endpoint(
  "post",
  "/products/:id/components",
  "catalog.write",
  z
    .object({
      components: z
        .array(z.object({ product_id: uuid, quantity }).strict())
        .min(1)
        .max(100),
    })
    .strict(),
  "Configure non-nested stock bundle recipe",
  async (ctx, i, req) => {
    const p = await one(
      ctx,
      "SELECT * FROM products WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, idOf(req)],
    );
    if (p.kind !== "bundle") fail(422, "NOT_BUNDLE", "Product is not a bundle");
    uniqueIds(i.components.map((c: any) => c.product_id));
    for (const c of i.components) {
      const cp = await one(
        ctx,
        "SELECT * FROM products WHERE company_id=$1 AND id=$2",
        [ctx.companyId, c.product_id],
      );
      if (
        cp.kind !== "stock" ||
        cp.batch_tracked ||
        cp.serial_tracked ||
        cp.id === p.id
      )
        fail(
          422,
          "INVALID_COMPONENT",
          "Bundle components must be untracked physical stock",
        );
    }
    const before = (
      await ctx.db.query(
        "SELECT * FROM bundle_components WHERE company_id=$1 AND bundle_id=$2",
        [ctx.companyId, p.id],
      )
    ).rows;
    await ctx.db.query(
      "DELETE FROM bundle_components WHERE company_id=$1 AND bundle_id=$2",
      [ctx.companyId, p.id],
    );
    for (const c of i.components)
      await ctx.db.query(
        "INSERT INTO bundle_components(company_id,bundle_id,product_id,quantity) VALUES($1,$2,$3,$4)",
        [ctx.companyId, p.id, c.product_id, c.quantity],
      );
    await ctx.db.query(
      "UPDATE products SET updated_at=now() WHERE company_id=$1 AND id=$2",
      [ctx.companyId, p.id],
    );
    await audit(ctx, "recipe.update", "product", p.id, before, i.components);
    return i;
  },
);
endpoint(
  "post",
  "/products/import",
  "catalog.write",
  z.object({ products: z.array(productSchema).min(1).max(500) }).strict(),
  "Atomic validated bulk catalog import",
  async (ctx, i) => {
    const products = [];
    for (const p of i.products) products.push(await createProduct(ctx, p));
    return { imported: products.length, ids: products.map((p) => p.id) };
  },
);
endpoint(
  "post",
  "/products/bulk-prices",
  "catalog.write",
  z
    .object({
      reason,
      prices: z
        .array(z.object({ product_id: uuid, price: amount }).strict())
        .min(1)
        .max(500),
    })
    .strict(),
  "Audited atomic bulk price update",
  async (ctx, i) => {
    uniqueIds(i.prices.map((p: any) => p.product_id));
    for (const p of i.prices) {
      const old = await one(
        ctx,
        "SELECT price FROM products WHERE company_id=$1 AND id=$2 FOR UPDATE",
        [ctx.companyId, p.product_id],
      );
      await ctx.db.query(
        "UPDATE products SET price=$1,updated_at=now() WHERE company_id=$2 AND id=$3",
        [p.price, ctx.companyId, p.product_id],
      );
      await audit(
        ctx,
        "price.update",
        "product",
        p.product_id,
        old,
        { price: p.price },
        i.reason,
      );
    }
    return { updated: i.prices.length };
  },
);
endpoint(
  "post",
  "/prices",
  "catalog.write",
  z
    .object({
      product_id: uuid,
      price_list_id: uuid.optional(),
      customer_id: uuid.optional(),
      supplier_id: uuid.optional(),
      min_quantity: quantity.default("1"),
      price: amount,
    })
    .strict()
    .refine(
      (v) =>
        [v.price_list_id, v.customer_id, v.supplier_id].filter(Boolean)
          .length === 1,
    ),
  "Set quantity-tier list/customer/supplier pricing",
  async (ctx, i) => {
    const p = await one(
      ctx,
      "SELECT id FROM products WHERE company_id=$1 AND id=$2",
      [ctx.companyId, i.product_id],
    );
    const row = (
      await ctx.db.query(
        "INSERT INTO prices(company_id,product_id,price_list_id,customer_id,supplier_id,min_quantity,price) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company_id,product_id,price_list_id,customer_id,supplier_id,min_quantity) DO UPDATE SET price=EXCLUDED.price RETURNING *",
        [
          ctx.companyId,
          p.id,
          i.price_list_id ?? null,
          i.customer_id ?? null,
          i.supplier_id ?? null,
          i.min_quantity,
          i.price,
        ],
      )
    ).rows[0];
    await audit(ctx, "set", "price", row.id, null, row);
    return row;
  },
);
for (const kind of ["customer", "supplier"] as const) {
  const base = "/" + kind + "s",
    perm = kind === "customer" ? "customers" : "suppliers";
  endpoint(
    "get",
    base,
    perm + ".read",
    undefined,
    `Search ${kind}s`,
    (ctx, q) => listContacts(ctx, kind, q),
  );
  endpoint(
    "post",
    base,
    perm + ".write",
    kind === "customer" ? customerSchema : supplierSchema,
    `Create ${kind}`,
    (ctx, i) => saveContact(ctx, kind, i),
  );
  endpoint(
    "put",
    base + "/:id",
    perm + ".write",
    kind === "customer" ? customerSchema : supplierSchema,
    `Update ${kind}`,
    (ctx, i, req) => saveContact(ctx, kind, i, idOf(req)),
  );
  endpoint(
    "get",
    base + "/:id/statement",
    perm + ".read",
    undefined,
    `Ledger-backed ${kind} statement`,
    async (ctx, q, req) =>
      q.format === "pdf"
        ? {
            raw: await statementPdf(ctx, kind, idOf(req), q),
            contentType: "application/pdf",
            filename: `${kind}-statement.pdf`,
          }
        : contactStatement(ctx, kind, idOf(req), q),
  );
  endpoint(
    "post",
    base + "/settlements",
    kind === "customer" ? "payments.receive" : "payments.pay",
    settlementSchema,
    `Post and allocate ${kind} payment`,
    (ctx, i) => settleContact(ctx, kind, i),
  );
  endpoint(
    "post",
    base + "/advances/apply",
    kind === "customer" ? "payments.receive" : "payments.pay",
    z
      .object({
        source_id: uuid,
        document_id: uuid,
        document_type: z.enum(["invoice", "opening"]).default("invoice"),
        amount: amount.refine((v) => D(v).gt(0)),
        accounting_date: date.optional(),
      })
      .strict(),
    `Apply a remaining ${kind} advance`,
    (ctx, i) => applyAdvance(ctx, kind, i),
  );
}
endpoint(
  "post",
  "/pos/price",
  "sales.create",
  checkoutSchema,
  "Recalculate a cart on the server without posting",
  async (ctx, i) => {
    const d = await accountingDate(ctx, i.accounting_date);
    const p = await priceCart(ctx, i, d);
    return {
      subtotal: p.subtotal,
      tax: p.tax,
      total: p.total,
      discount: p.discount,
      lines: p.lines.map(({ product, ...l }) => l),
    };
  },
  { idempotent: false },
);
endpoint(
  "post",
  "/sales",
  "sales.create",
  checkoutSchema,
  "Post atomic checkout, stock, tenders and balanced journal",
  checkout,
  {
    filterResponse: async (ctx, result) => {
      const source = await one(
        ctx,
        "SELECT branch_id,warehouse_id FROM sales WHERE company_id=$1 AND id=$2",
        [ctx.companyId, result.id],
      );
      branchAccess(ctx, source.branch_id);
      await warehouseAccess(ctx, source.warehouse_id);
      return redactCosts(ctx, result);
    },
  },
);
endpoint(
  "get",
  "/sales",
  "sales.read",
  undefined,
  "Search posted sales",
  listSales,
);
endpoint(
  "get",
  "/sales/:id",
  "sales.read",
  undefined,
  "Invoice, tender, stock cost and fiscal state",
  (ctx, _q, req) => getSale(ctx, idOf(req)),
);
endpoint(
  "get",
  "/sales/:id/receipt",
  "sales.read",
  undefined,
  "Audited A4 or thermal PDF; fiscal state is explicit",
  async (ctx, q, req) => ({
    raw: await salePdf(ctx, idOf(req), q.thermal === "true"),
    contentType: "application/pdf",
    filename: `receipt-${idOf(req)}.pdf`,
  }),
);
endpoint(
  "post",
  "/sales/returns",
  "sales.return",
  saleReturnSchema,
  "Post capped partial return, stock disposition and refund",
  returnSale,
);
endpoint(
  "get",
  "/sales/returns/list",
  "sales.read",
  undefined,
  "Paginated returns and credit notes",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT r.*,s.number AS sale_number,count(*) OVER()::int AS _count FROM sale_returns r JOIN sales s ON s.company_id=r.company_id AND s.id=r.sale_id WHERE r.company_id=$1 AND r.branch_id=ANY($2::uuid[]) ORDER BY r.created_at DESC",
      [ctx.companyId, ctx.actor.branch_ids],
      q,
    ),
);
endpoint(
  "get",
  "/pos/suspended",
  "sales.create",
  undefined,
  "Owned saved carts",
  (ctx) =>
    ctx.db
      .query(
        "SELECT * FROM suspended_sales WHERE company_id=$1 AND user_id=$2 AND branch_id=ANY($3::uuid[]) ORDER BY created_at DESC LIMIT 100",
        [ctx.companyId, ctx.actor.id, ctx.actor.branch_ids],
      )
      .then((r) => ({ items: r.rows })),
);
endpoint(
  "post",
  "/pos/suspended",
  "sales.create",
  z
    .object({
      branch_id: uuid,
      label: z.string().trim().min(1).max(100),
      cart: checkoutSchema,
    })
    .strict(),
  "Save a cart without posting stock or money",
  async (ctx, i) => {
    branchAccess(ctx, i.branch_id);
    const r = (
      await ctx.db.query(
        "INSERT INTO suspended_sales(company_id,user_id,branch_id,label,cart) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [
          ctx.companyId,
          ctx.actor.id,
          i.branch_id,
          i.label,
          JSON.stringify(i.cart),
        ],
      )
    ).rows[0];
    await audit(ctx, "suspend", "cart", r.id, null, { label: i.label });
    return r;
  },
);
endpoint(
  "delete",
  "/pos/suspended/:id",
  "sales.create",
  undefined,
  "Remove an owned saved cart after resuming",
  async (ctx, _i, req) => {
    const r = await ctx.db.query(
      "DELETE FROM suspended_sales WHERE company_id=$1 AND user_id=$2 AND id=$3 RETURNING id",
      [ctx.companyId, ctx.actor.id, idOf(req)],
    );
    if (!r.rowCount) fail(404, "NOT_FOUND", "Saved cart not found");
    await audit(ctx, "resume", "cart", idOf(req));
    return { removed: true };
  },
);
endpoint(
  "get",
  "/shifts",
  undefined,
  undefined,
  "Cashier shifts visible to their owner or manager",
  (ctx, q) => {
    requireOneOf(ctx, ["shifts.open", "shifts.review", "shifts.manage"]);
    return pageQuery(
      ctx,
      `SELECT s.*,r.name AS register,u.name AS cashier,count(*) OVER()::int AS _count FROM shifts s JOIN registers r ON r.company_id=s.company_id AND r.id=s.register_id JOIN identities u ON u.company_id=s.company_id AND u.id=s.cashier_id WHERE s.company_id=$1 AND s.branch_id=ANY($2::uuid[]) AND ($3::boolean OR s.cashier_id=$4) ORDER BY s.opened_at DESC`,
      [
        ctx.companyId,
        ctx.actor.branch_ids,
        has(ctx, "shifts.review") || has(ctx, "shifts.manage"),
        ctx.actor.id,
      ],
      q,
    );
  },
);
endpoint(
  "post",
  "/shifts/open",
  "shifts.open",
  openShiftSchema,
  "Open a till with counted float",
  openShift,
);
endpoint(
  "get",
  "/shifts/:id",
  undefined,
  undefined,
  "Expected balances by payment method",
  (ctx, _q, req) => expectedShift(ctx, idOf(req)),
);
endpoint(
  "post",
  "/shifts/:id/close",
  "shifts.open",
  closeShiftSchema,
  "Submit denomination count and reconciliation",
  (ctx, i, req) => closeShift(ctx, idOf(req), i),
);
endpoint(
  "post",
  "/shifts/:id/review",
  "shifts.review",
  z.object({ status: z.enum(["approved", "rejected"]), reason }).strict(),
  "Review cashier reconciliation and post cash variance",
  (ctx, i, req) => reviewShift(ctx, idOf(req), i.status, i.reason),
);
endpoint(
  "post",
  "/shifts/cash-movements",
  "shifts.manage",
  z
    .object({
      shift_id: uuid,
      direction: z.enum(["in", "out"]),
      amount: amount.refine((v) => D(v).gt(0)),
      account_id: uuid,
      reason,
    })
    .strict(),
  "Audited cash-in/out, petty cash or bank transfer",
  cashMovement,
);
endpoint(
  "get",
  "/inventory/balances",
  "inventory.read",
  undefined,
  "Available stock and moving weighted-average value",
  inventoryBalances,
);
endpoint(
  "get",
  "/inventory/movements",
  "inventory.read",
  undefined,
  "Append-only stock ledger",
  stockLedger,
);
endpoint(
  "post",
  "/inventory/documents",
  undefined,
  stockInputSchema,
  "Opening, adjustment, transfer or optimistic count",
  postStockDocument,
);
endpoint(
  "get",
  "/accounting/integrity",
  "accounting.read",
  undefined,
  "Company-wide subledger, stock, journal and tracking integrity",
  verifyIntegrity,
);
endpoint(
  "get",
  "/inventory/reconciliation",
  "accounting.read",
  undefined,
  "Reconcile balance cache, movements and inventory GL",
  reconcileInventory,
);
endpoint(
  "get",
  "/inventory/batches",
  "inventory.read",
  undefined,
  "Batch quantities and expiry alerts",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT b.*,p.name,w.name AS warehouse,(b.expiry_date<CURRENT_DATE) AS expired,count(*) OVER()::int AS _count FROM stock_batches b JOIN products p ON p.company_id=b.company_id AND p.id=b.product_id JOIN warehouses w ON w.company_id=b.company_id AND w.id=b.warehouse_id WHERE b.company_id=$1 AND b.warehouse_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR b.product_id=$3) AND ($4::uuid IS NULL OR b.warehouse_id=$4) AND (p.name ILIKE $5 OR p.sku ILIKE $5 OR b.batch_number ILIKE $5) ORDER BY b.expiry_date NULLS LAST,b.batch_number",
      [
        ctx.companyId,
        ctx.actor.warehouse_ids,
        q.product_id ?? null,
        q.warehouse_id ?? null,
        `%${q.q ?? ""}%`,
      ],
      q,
    ),
);
endpoint(
  "get",
  "/inventory/serials",
  "inventory.read",
  undefined,
  "Serial-number availability",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT s.*,p.name,count(*) OVER()::int AS _count FROM serial_numbers s JOIN products p ON p.company_id=s.company_id AND p.id=s.product_id WHERE s.company_id=$1 AND s.warehouse_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR s.product_id=$3) AND ($4::uuid IS NULL OR s.warehouse_id=$4) AND (p.name ILIKE $5 OR p.sku ILIKE $5 OR s.serial ILIKE $5) ORDER BY s.serial",
      [
        ctx.companyId,
        ctx.actor.warehouse_ids,
        q.product_id ?? null,
        q.warehouse_id ?? null,
        `%${q.q ?? ""}%`,
      ],
      q,
    ),
);
endpoint(
  "post",
  "/purchases/orders",
  "purchases.create",
  poSchema,
  "Create a purchase order",
  createPurchaseOrder,
);
endpoint(
  "get",
  "/purchases/orders",
  "purchases.read",
  undefined,
  "Search purchase orders",
  (ctx, q) => listPurchases(ctx, "orders", q),
);
endpoint(
  "get",
  "/purchases/orders/:id",
  "purchases.read",
  undefined,
  "PO lines and partial delivery progress",
  (ctx, _q, req) => getPurchaseOrder(ctx, idOf(req)),
);
endpoint(
  "post",
  "/purchases/orders/:id/transition",
  undefined,
  z
    .object({
      status: z.enum([
        "submitted",
        "approved",
        "rejected",
        "closed",
        "cancelled",
      ]),
      reason,
    })
    .strict(),
  "Submit, approve, reject or close a PO",
  (ctx, i, req) => transitionPurchaseOrder(ctx, idOf(req), i.status, i.reason),
);
endpoint(
  "post",
  "/purchases/receipts",
  "purchases.receive",
  grnSchema,
  "Receive accepted goods and accrue GRNI",
  receiveGoods,
);
endpoint(
  "get",
  "/purchases/receipts",
  "purchases.read",
  undefined,
  "Search goods receipts",
  (ctx, q) => listPurchases(ctx, "receipts", q),
);
endpoint(
  "get",
  "/purchases/receipts/:id",
  "purchases.read",
  undefined,
  "GRN lines for invoice matching",
  (ctx, _q, req) => getGoodsReceipt(ctx, idOf(req)),
);
endpoint(
  "post",
  "/purchases/invoices",
  "purchases.create",
  supplierInvoiceSchema,
  "Recognize matched invoice, input tax and AP",
  recognizeSupplierInvoice,
);
endpoint(
  "get",
  "/purchases/invoices",
  "purchases.read",
  undefined,
  "Outstanding supplier invoices",
  (ctx, q) => listPurchases(ctx, "invoices", q),
);
endpoint(
  "post",
  "/purchases/returns",
  "purchases.create",
  supplierReturnSchema,
  "Supplier return with stock and liability credit",
  returnSupplierGoods,
);
endpoint(
  "get",
  "/documents",
  "documents.write",
  undefined,
  "Quotations, orders, delivery notes and requisitions",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT d.*,c.name AS customer,count(*) OVER()::int AS _count FROM business_documents d LEFT JOIN customers c ON c.company_id=d.company_id AND c.id=d.customer_id WHERE d.company_id=$1 AND d.branch_id=ANY($2::uuid[]) ORDER BY d.created_at DESC",
      [ctx.companyId, ctx.actor.branch_ids],
      q,
    ),
);
endpoint(
  "post",
  "/documents",
  "documents.write",
  documentSchema,
  "Server-priced commercial document",
  createDocument,
);
endpoint(
  "get",
  "/documents/:id",
  "documents.write",
  undefined,
  "Read a scoped commercial document",
  async (ctx, _q, req) => {
    const d = await one(
      ctx,
      "SELECT * FROM business_documents WHERE company_id=$1 AND id=$2",
      [ctx.companyId, idOf(req)],
    );
    branchAccess(ctx, d.branch_id);
    return d;
  },
);
endpoint(
  "post",
  "/documents/:id/transition",
  "documents.write",
  z
    .object({
      status: z.enum(["submitted", "approved", "rejected", "cancelled"]),
      reason,
    })
    .strict(),
  "Document approval and stock reservation",
  (ctx, i, req) => transitionDocument(ctx, idOf(req), i.status, i.reason),
);
endpoint(
  "post",
  "/documents/:id/to-purchase-order",
  "purchases.create",
  z.object({ supplier_id: uuid }).strict(),
  "Convert approved requisition into linked PO",
  (ctx, i, req) => requisitionToOrder(ctx, idOf(req), i.supplier_id),
);
endpoint(
  "get",
  "/print/:kind/:id",
  undefined,
  undefined,
  "Audited printable business document",
  async (ctx, _q, req) => ({
    raw: await businessPdf(ctx, String(req.params.kind), idOf(req)),
    contentType: "application/pdf",
    filename: `${String(req.params.kind)}-${idOf(req)}.pdf`,
  }),
);
endpoint(
  "get",
  "/expenses",
  "expenses.read",
  undefined,
  "Expense requests and posted vouchers",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT e.*,c.name AS category,u.name AS created_by_name,coalesce((SELECT sum(CASE WHEN r.kind='refund' THEN r.amount ELSE -r.amount END) FROM expense_refunds r WHERE r.company_id=e.company_id AND r.expense_id=e.id),0)::text AS refunded,(e.total-coalesce((SELECT sum(CASE WHEN r.kind='refund' THEN r.amount ELSE -r.amount END) FROM expense_refunds r WHERE r.company_id=e.company_id AND r.expense_id=e.id),0))::text AS remaining,count(*) OVER()::int AS _count FROM expenses e JOIN expense_categories c ON c.company_id=e.company_id AND c.id=e.category_id JOIN identities u ON u.company_id=e.company_id AND u.id=e.created_by WHERE e.company_id=$1 AND e.branch_id=ANY($2::uuid[]) AND ($3::text IS NULL OR e.status=$3) ORDER BY e.created_at DESC",
      [ctx.companyId, ctx.actor.branch_ids, q.status ?? null],
      q,
    ),
);
endpoint(
  "post",
  "/expenses",
  "expenses.create",
  expenseSchema.extend({ attachment: attachmentPayloadSchema.optional() }),
  "Request expense and optional private receipt atomically",
  async (ctx, i) => {
    const { attachment, ...expense } = i;
    const result = await createExpense(ctx, expense);
    if (attachment)
      await storeAttachment(ctx, {
        ...attachment,
        entity: "expense",
        record_id: result.id,
      });
    return result;
  },
);
endpoint(
  "post",
  "/expenses/:id/review",
  "expenses.approve",
  z.object({ status: z.enum(["approved", "rejected"]), reason }).strict(),
  "Approve within configured authority limit",
  (ctx, i, req) => reviewExpense(ctx, idOf(req), i.status, i.reason),
);
endpoint(
  "post",
  "/expenses/:id/pay",
  "expenses.pay",
  paymentInput,
  "Pay approved expense and post journal",
  (ctx, i, req) => payExpense(ctx, idOf(req), i),
);
endpoint(
  "post",
  "/expenses/:id/void",
  "expenses.approve",
  z.object({ reason }).strict(),
  "Void an erroneous no-transfer expense posting at its original date",
  (ctx, i, req) => voidExpense(ctx, idOf(req), i),
);
endpoint(
  "post",
  "/expenses/:id/reclassify",
  "expenses.approve",
  z
    .object({
      to_account_id: uuid,
      amount: amount.refine((v) => D(v).gt(0)),
      reason,
      accounting_date: date.optional(),
    })
    .strict(),
  "Reclassify a posted expense between expense accounts",
  (ctx, i, req) => reclassifyExpense(ctx, idOf(req), i),
);
endpoint(
  "get",
  "/accounting/accounts",
  "accounting.read",
  undefined,
  "Chart of accounts",
  (ctx) =>
    ctx.db
      .query("SELECT * FROM accounts WHERE company_id=$1 ORDER BY code", [
        ctx.companyId,
      ])
      .then((r) => ({ items: r.rows })),
);
endpoint(
  "post",
  "/accounting/accounts",
  "accounting.post",
  z
    .object({
      code: z.string().regex(/^[A-Za-z0-9-]{2,20}$/),
      name: z.string().min(2).max(160),
      type: z.enum(["asset", "liability", "equity", "income", "expense"]),
    })
    .strict(),
  "Create a configurable non-system account",
  async (ctx, i) => {
    const a = (
      await ctx.db.query(
        "INSERT INTO accounts(company_id,code,name,type) VALUES($1,$2,$3,$4) RETURNING *",
        [ctx.companyId, i.code, i.name, i.type],
      )
    ).rows[0];
    await audit(ctx, "create", "account", a.id, null, a);
    return a;
  },
);
endpoint(
  "get",
  "/accounting/journals",
  "accounting.read",
  undefined,
  "Immutable journal listing with reversal state",
  (ctx, q) =>
    pageQuery(
      ctx,
      `SELECT j.*,u.name AS created_by_name,(SELECT sum(l.debit)::text FROM journal_lines l WHERE l.company_id=j.company_id AND l.journal_id=j.id) AS total,(SELECT r.id FROM journals r WHERE r.company_id=j.company_id AND r.reversal_of=j.id) AS reversed_by,count(*) OVER()::int AS _count FROM journals j JOIN identities u ON u.company_id=j.company_id AND u.id=j.created_by WHERE j.company_id=$1 AND j.branch_id=ANY($2::uuid[]) AND ($3::date IS NULL OR accounting_date>=$3) AND ($4::date IS NULL OR accounting_date<=$4) ORDER BY j.created_at DESC`,
      [ctx.companyId, ctx.actor.branch_ids, q.from ?? null, q.to ?? null],
      q,
    ),
);
endpoint(
  "get",
  "/accounting/journals/:id",
  "accounting.read",
  undefined,
  "Journal debit/credit detail",
  async (ctx, _q, req) => {
    const j = await one(
      ctx,
      "SELECT * FROM journals WHERE company_id=$1 AND id=$2",
      [ctx.companyId, idOf(req)],
    );
    branchAccess(ctx, j.branch_id);
    return {
      ...j,
      lines: (
        await ctx.db.query(
          "SELECT l.*,a.code,a.name AS account FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND l.journal_id=$2 ORDER BY a.code",
          [ctx.companyId, j.id],
        )
      ).rows,
    };
  },
);
endpoint(
  "post",
  "/accounting/journals",
  "accounting.post",
  journalSchema,
  "Balanced manual journal; operational control accounts are protected",
  async (ctx, i) => {
    branchAccess(ctx, i.branch_id);
    for (const l of i.lines) {
      const a = await one(
        ctx,
        "SELECT * FROM accounts WHERE company_id=$1 AND id=$2 AND active",
        [ctx.companyId, l.account_id],
      );
      if (
        [
          "inventory",
          "ar",
          "ap",
          "grni",
          "customer_advances",
          "supplier_advances",
          "refund_payable",
        ].includes(a.system_key)
      )
        fail(
          422,
          "CONTROL_ACCOUNT",
          "Use the related stock, customer, supplier or refund workflow, not a GL-only correction",
        );
    }
    const result = await postJournal(ctx, {
      branchId: i.branch_id,
      date: i.accounting_date,
      sourceType: "manual",
      sourceId: randomUUID(),
      description: i.description,
      lines: i.lines.map((l: any) => ({
        account: l.account_id,
        byId: true,
        debit: l.debit,
        credit: l.credit,
        customerId: l.customer_id,
        supplierId: l.supplier_id,
        memo: l.memo,
      })),
    });
    await audit(ctx, "manual.post", "journal", result.id, null, i, i.reason);
    return result;
  },
);
endpoint(
  "post",
  "/accounting/journals/:id/reverse",
  "accounting.reverse",
  z.object({ accounting_date: date, reason }).strict(),
  "Reverse eligible manual/opening journal without deletion",
  (ctx, i, req) => reverseJournal(ctx, idOf(req), i.accounting_date, i.reason),
);
endpoint(
  "post",
  "/accounting/periods",
  "accounting.close",
  z
    .object({
      name: z.string().min(1).max(80),
      start_date: date,
      end_date: date,
    })
    .strict(),
  "Create a non-overlapping operating period",
  async (ctx, i) => {
    if (i.start_date > i.end_date)
      fail(422, "PERIOD_DATES", "Invalid period date range");
    await ctx.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      ctx.companyId + ":periods",
    ]);
    const overlap = await ctx.db.query(
      "SELECT id FROM accounting_periods WHERE company_id=$1 AND start_date<=$2 AND end_date>=$3",
      [ctx.companyId, i.end_date, i.start_date],
    );
    if (overlap.rowCount)
      fail(409, "PERIOD_OVERLAP", "Accounting periods cannot overlap");
    const r = (
      await ctx.db.query(
        "INSERT INTO accounting_periods(company_id,name,start_date,end_date) VALUES($1,$2,$3,$4) RETURNING *",
        [ctx.companyId, i.name, i.start_date, i.end_date],
      )
    ).rows[0];
    await audit(ctx, "create", "accounting_period", r.id, null, r);
    return r;
  },
);
endpoint(
  "post",
  "/accounting/periods/:id/status",
  "accounting.close",
  z.object({ status: z.enum(["open", "closed"]), reason }).strict(),
  "Close or explicitly reopen an accounting period",
  async (ctx, i, req) => {
    await requireAllBranches(ctx);
    const p = await one(
      ctx,
      "SELECT * FROM accounting_periods WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, idOf(req)],
    );
    if (i.status === p.status)
      fail(409, "INVALID_STATE", "Period already has this status");
    if (i.status === "closed") {
      const totalBranches = (
        await ctx.db.query(
          "SELECT count(*)::int AS n FROM branches WHERE company_id=$1",
          [ctx.companyId],
        )
      ).rows[0].n;
      if (ctx.actor.branch_ids.length !== totalBranches)
        fail(
          403,
          "ALL_BRANCHES_REQUIRED",
          "Closing company periods requires access to all branches",
        );
      const reconciliation = await verifyIntegrity(ctx);
      if (!reconciliation.matches)
        fail(
          409,
          "SUBLEDGERS_UNRECONCILED",
          "Reconcile stock, tracking and all control accounts before closing the accounting period",
          reconciliation,
        );
    }
    await ctx.db.query(
      "UPDATE accounting_periods SET status=$1,closed_by=$2,closed_at=CASE WHEN $1='closed' THEN now() ELSE NULL END WHERE company_id=$3 AND id=$4",
      [i.status, ctx.actor.id, ctx.companyId, p.id],
    );
    await audit(
      ctx,
      i.status,
      "accounting_period",
      p.id,
      p,
      { status: i.status },
      i.reason,
    );
    return { id: p.id, status: i.status };
  },
  { isolation: "repeatable read" },
);
endpoint(
  "get",
  "/accounting/assets",
  "accounting.read",
  undefined,
  "Fixed assets and accumulated depreciation",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT a.*,coalesce((SELECT sum(amount) FROM depreciation_runs d WHERE d.company_id=a.company_id AND d.asset_id=a.id),0)::text AS depreciated,count(*) OVER()::int AS _count FROM fixed_assets a WHERE a.company_id=$1 AND a.branch_id=ANY($2::uuid[]) ORDER BY a.name",
      [ctx.companyId, ctx.actor.branch_ids],
      q,
    ),
);
endpoint(
  "post",
  "/accounting/assets",
  "accounting.post",
  z
    .object({
      branch_id: uuid,
      name: z.string().min(2).max(160),
      cost: amount.refine((v) => D(v).gt(0)),
      residual: amount.default("0"),
      useful_months: z.number().int().min(1).max(1200),
      acquired_date: date,
      funding: z.enum(["opening", "payment"]).default("opening"),
      tax: amount.optional(),
      payment: checkoutSchema.shape.payments.element.optional(),
      shift_id: uuid.optional(),
    })
    .strict(),
  "Register a fixed asset: opening against equity or paid with a real tender",
  acquireAsset,
);
endpoint(
  "post",
  "/accounting/assets/:id/dispose",
  "accounting.post",
  z
    .object({
      proceeds: amount.refine((v) => D(v).gte(0)),
      reason,
      accounting_date: date,
      payment: checkoutSchema.shape.payments.element.optional(),
      shift_id: uuid.optional(),
    })
    .strict(),
  "Dispose of a fixed asset with exact book removal and gain/loss posting",
  (ctx, i, req) => disposeAsset(ctx, idOf(req), i),
);
endpoint(
  "post",
  "/accounting/assets/:id/depreciate",
  "accounting.post",
  z.object({ accounting_date: date }).strict(),
  "Post straight-line monthly depreciation exactly once",
  (ctx, i, req) => depreciateAsset(ctx, idOf(req), i.accounting_date),
);
endpoint(
  "post",
  "/accounting/budgets",
  "accounting.post",
  z
    .object({ branch_id: uuid, account_id: uuid, period_id: uuid, amount })
    .strict(),
  "Set branch/account/period budget",
  async (ctx, i) => {
    branchAccess(ctx, i.branch_id);
    const r = (
      await ctx.db.query(
        "INSERT INTO budgets(company_id,branch_id,account_id,period_id,amount) VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id,branch_id,account_id,period_id) DO UPDATE SET amount=EXCLUDED.amount RETURNING *",
        [ctx.companyId, i.branch_id, i.account_id, i.period_id, i.amount],
      )
    ).rows[0];
    await audit(ctx, "set", "budget", r.id, null, i);
    return r;
  },
);
endpoint(
  "post",
  "/accounting/bank-reconciliations",
  "accounting.post",
  z
    .object({
      account_id: uuid,
      statement_date: date,
      statement_balance: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
      journal_line_ids: z.array(uuid).max(1000),
    })
    .strict(),
  "Match bank ledger lines to a confirmed statement balance",
  async (ctx, i) => {
    await requireAllBranches(ctx);
    const a = await one(
      ctx,
      "SELECT * FROM accounts WHERE company_id=$1 AND id=$2 AND type='asset'",
      [ctx.companyId, i.account_id],
    );
    if (!["bank", "mpesa", "card", "cash"].includes(a.system_key))
      fail(
        422,
        "NOT_CASH_ACCOUNT",
        "Select a configured cash or settlement account",
      );
    uniqueIds(i.journal_line_ids);
    await ctx.db.query(
      "SELECT id FROM accounts WHERE company_id=$1 AND id=$2 FOR UPDATE",
      [ctx.companyId, a.id],
    );
    const id = randomUUID();
    await ctx.db.query(
      "INSERT INTO bank_reconciliations(id,company_id,account_id,statement_date,statement_balance,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        ctx.companyId,
        a.id,
        i.statement_date,
        i.statement_balance,
        ctx.actor.id,
      ],
    );
    for (const line of i.journal_line_ids) {
      const l = await one(
        ctx,
        "SELECT l.*,j.branch_id,j.accounting_date FROM journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=$1 AND l.id=$2 AND l.account_id=$3 AND j.accounting_date<=$4",
        [ctx.companyId, line, a.id, i.statement_date],
      );
      branchAccess(ctx, l.branch_id);
      await ctx.db.query(
        "INSERT INTO bank_reconciliation_lines(company_id,reconciliation_id,journal_line_id) VALUES($1,$2,$3)",
        [ctx.companyId, id, line],
      );
    }
    const matched = (
      await ctx.db.query(
        "SELECT coalesce(sum(l.debit-l.credit),0)::text AS n FROM bank_reconciliation_lines r JOIN journal_lines l ON l.company_id=r.company_id AND l.id=r.journal_line_id JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE r.company_id=$1 AND l.account_id=$2 AND j.accounting_date<=$3 AND j.branch_id=ANY($4::uuid[])",
        [ctx.companyId, a.id, i.statement_date, ctx.actor.branch_ids],
      )
    ).rows[0].n;
    if (!D(matched).eq(i.statement_balance))
      fail(
        409,
        "BANK_RECONCILIATION_DIFFERENCE",
        "Matched cumulative ledger balance differs from statement",
        { matched, statement: i.statement_balance },
      );
    await ctx.db.query(
      "UPDATE bank_reconciliations SET status='reconciled' WHERE company_id=$1 AND id=$2",
      [ctx.companyId, id],
    );
    await audit(ctx, "reconcile", "bank_reconciliation", id, null, i);
    return { id, status: "reconciled", balance: matched };
  },
);
const reports: Record<string, (ctx: Context, q: any) => Promise<any>> = {
  "trial-balance": trialBalance,
  pnl: profitAndLoss,
  "balance-sheet": balanceSheet,
  gl: generalLedger,
  "cash-flow": cashFlow,
  "ar-aging": (ctx, q) => aging(ctx, "customer", q),
  "ap-aging": (ctx, q) => aging(ctx, "supplier", q),
  tax: taxSummary,
  valuation: inventoryValuation,
  sales: salesAnalysis,
};
endpoint(
  "get",
  "/reports/:name",
  "reports.read",
  undefined,
  "Filtered ledger-derived financial and trading report",
  async (ctx, q, req) => {
    const name = String(req.params.name),
      fn = reports[name];
    if (!fn) fail(404, "NOT_FOUND", "Unknown report");
    if (q.format === "pdf")
      return {
        raw: await reportPdf(ctx, name, q),
        contentType: "application/pdf",
        filename: name + ".pdf",
      };
    const r = await fn(ctx, q);
    if (q.format === "csv")
      return {
        raw: csv(
          r.items ??
            r.income?.concat(r.expenses) ??
            r.assets?.concat(r.liabilities, r.equity) ??
            [],
        ),
        contentType: "text/csv; charset=utf-8",
        filename: name + ".csv",
      };
    return r;
  },
);
endpoint(
  "get",
  "/payments",
  "reports.read",
  undefined,
  "Confirmed immutable tender register",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT p.*,m.name AS method,u.name AS creator,count(*) OVER()::int AS _count FROM payments p JOIN payment_methods m ON m.company_id=p.company_id AND m.id=p.method_id JOIN identities u ON u.company_id=p.company_id AND u.id=p.created_by WHERE p.company_id=$1 AND p.branch_id=ANY($2::uuid[]) AND ($3::date IS NULL OR p.accounting_date>=$3) AND ($4::date IS NULL OR p.accounting_date<=$4) ORDER BY p.created_at DESC",
      [ctx.companyId, ctx.actor.branch_ids, q.from ?? null, q.to ?? null],
      q,
    ),
);
endpoint(
  "get",
  "/payments/advances",
  undefined,
  undefined,
  "Unapplied customer and supplier credits",
  (ctx, q) => {
    requireOneOf(ctx, ["payments.receive", "payments.pay"]);
    return pageQuery(
      ctx,
      `WITH credits AS MATERIALIZED(SELECT c.*,coalesce(cu.name,su.name) AS contact,(c.amount-coalesce((SELECT sum(u.amount) FROM advance_uses u WHERE u.company_id=c.company_id AND u.credit_id=c.id),0)) AS available FROM advance_credits c LEFT JOIN customers cu ON cu.company_id=c.company_id AND cu.id=c.customer_id LEFT JOIN suppliers su ON su.company_id=c.company_id AND su.id=c.supplier_id WHERE c.company_id=$1 AND c.branch_id=ANY($2::uuid[]) AND ((c.customer_id IS NOT NULL AND $3::boolean) OR(c.supplier_id IS NOT NULL AND $4::boolean)) AND ($5::uuid IS NULL OR coalesce(c.customer_id,c.supplier_id)=$5)) SELECT *,count(*) OVER()::int AS _count FROM credits WHERE available>0 ORDER BY accounting_date,created_at,id`,
      [
        ctx.companyId,
        ctx.actor.branch_ids,
        has(ctx, "payments.receive"),
        has(ctx, "payments.pay"),
        q.contact_id ?? null,
      ],
      q,
    );
  },
);
endpoint(
  "get",
  "/payments/refunds",
  "sales.refund",
  undefined,
  "Pending external refund settlements",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT r.*,s.branch_id,s.number AS credit_note,m.name AS method,count(*) OVER()::int AS _count FROM refund_requests r JOIN sale_returns s ON s.company_id=r.company_id AND s.id=r.return_id JOIN payment_methods m ON m.company_id=r.company_id AND m.id=r.method_id WHERE r.company_id=$1 AND s.branch_id=ANY($2::uuid[]) ORDER BY r.created_at DESC",
      [ctx.companyId, ctx.actor.branch_ids],
      q,
    ),
);
endpoint(
  "post",
  "/payments/refunds/:id/confirm",
  "payments.pay",
  z
    .object({
      provider_reference: z.string().min(5).max(100),
      reason,
      accounting_date: date.optional(),
    })
    .strict(),
  "Record independently reconciled external refund settlement",
  async (ctx, i, req) => {
    requirePermission(ctx, "integrations.manage");
    const r = await one(
      ctx,
      "SELECT r.*,s.branch_id FROM refund_requests r JOIN sale_returns s ON s.company_id=r.company_id AND s.id=r.return_id WHERE r.company_id=$1 AND r.id=$2 FOR UPDATE OF r",
      [ctx.companyId, idOf(req)],
    );
    branchAccess(ctx, r.branch_id);
    if (r.status === "settled")
      fail(409, "REFUND_ALREADY_SETTLED", "Refund already settled");
    const method = await one(
      ctx,
      "SELECT * FROM payment_methods WHERE company_id=$1 AND id=$2",
      [ctx.companyId, r.method_id],
    );
    const d = await accountingDate(ctx, i.accounting_date);
    const paymentId = randomUUID();
    await ctx.db.query(
      "INSERT INTO payments(id,company_id,branch_id,method_id,amount,direction,source_type,source_id,reference,created_by,accounting_date) VALUES($1,$2,$3,$4,$5,'out','refund_settlement',$6,$7,$8,$9)",
      [
        paymentId,
        ctx.companyId,
        r.branch_id,
        method.id,
        r.amount,
        r.id,
        i.provider_reference,
        ctx.actor.id,
        d,
      ],
    );
    await ctx.db.query(
      "UPDATE refund_requests SET status='settled',provider_reference=$1,settled_by=$2 WHERE company_id=$3 AND id=$4",
      [i.provider_reference, ctx.actor.id, ctx.companyId, r.id],
    );
    await postJournal(ctx, {
      branchId: r.branch_id,
      date: d,
      sourceType: "refund_settlement",
      sourceId: r.id,
      description: i.reason,
      lines: [
        { account: "refund_payable", debit: r.amount },
        { account: method.account_id, byId: true, credit: r.amount },
      ],
    });
    await audit(
      ctx,
      "externally_reconciled",
      "refund_request",
      r.id,
      null,
      { reference: i.provider_reference, amount: r.amount },
      i.reason,
    );
    return { id: r.id, status: "settled" };
  },
);
endpoint(
  "post",
  "/integrations/mpesa/intents",
  "sales.create",
  z
    .object({
      branch_id: uuid,
      amount: amount.refine((v) => D(v).gt(0) && D(v).lte(999999999)),
      phone: z.string().regex(/^254[17]\d{8}$/),
      idempotency_key: z.string().trim().min(8).max(96).optional(),
    })
    .strict(),
  "Initiate STK Push; result remains pending",
  createIntent,
  { afterCommit: async (actor, result) => dispatchIntent(actor, result.id) },
);
endpoint(
  "get",
  "/integrations/mpesa/intents/:id",
  "sales.create",
  undefined,
  "Read confirmed provider status without credentials",
  async (ctx, _q, req) => {
    const i = await one(
      ctx,
      "SELECT id,branch_id,created_by,amount,phone,provider,status,checkout_id,receipt_number,consumed_by,last_error,created_at FROM payment_intents WHERE company_id=$1 AND id=$2",
      [ctx.companyId, idOf(req)],
    );
    branchAccess(ctx, i.branch_id);
    if (i.created_by !== ctx.actor.id && !has(ctx, "integrations.manage"))
      fail(403, "PAYMENT_OWNER", "Payment intent belongs to another operator");
    return { ...i, phone: "***" + i.phone.slice(-4) };
  },
);
endpoint(
  "post",
  "/integrations/mpesa/intents/:id/mock",
  "sales.create",
  z
    .object({
      status: z.enum(["successful", "failed", "cancelled", "timed_out"]),
    })
    .strict(),
  "Development-only mock provider outcome",
  async (ctx, i, req) => {
    const result = await mockComplete(ctx, idOf(req), i.status);
    return {
      id: result.intent.id,
      status: result.status,
      receipt: result.receipt,
      checkout_id: result.intent.checkout_id,
    };
  },
  {
    afterCommit: async (_actor, result) => {
      const { callbackToken } = await import("../integrations/mpesa.ts");
      const { pool } = await import("../db.ts");
      const source = (
        await pool.query(
          "SELECT * FROM mock_provider_transactions WHERE checkout_id=$1",
          [result.checkout_id],
        )
      ).rows[0];
      await receiveCallback(callbackToken(result.id), {
        Body: {
          stkCallback: {
            CheckoutRequestID: result.checkout_id,
            ResultCode: result.status === "successful" ? 0 : 1032,
            CallbackMetadata: {
              Item: [
                { Name: "Amount", Value: source.amount },
                { Name: "MpesaReceiptNumber", Value: result.receipt },
                { Name: "PhoneNumber", Value: source.phone },
              ],
            },
          },
        },
      });
      const events = (
        await pool.query(
          "SELECT id FROM provider_events WHERE checkout_id=$1 AND status='received'",
          [result.checkout_id],
        )
      ).rows;
      for (const e of events) await processMpesaEvent(e.id);
    },
  },
);
endpoint(
  "get",
  "/integrations/fiscal",
  "integrations.manage",
  undefined,
  "Fiscal failures, identifiers and retry state",
  (ctx, q) =>
    pageQuery(
      ctx,
      `SELECT f.*,coalesce(s.number,r.number) AS document_number,count(*) OVER()::int AS _count FROM fiscal_submissions f LEFT JOIN sales s ON s.company_id=f.company_id AND s.id=f.source_id AND f.source_type='sale' LEFT JOIN sale_returns r ON r.company_id=f.company_id AND r.id=f.source_id AND f.source_type='sale_return' WHERE f.company_id=$1 AND coalesce(s.branch_id,r.branch_id)=ANY($2::uuid[]) ORDER BY f.created_at DESC`,
      [ctx.companyId, ctx.actor.branch_ids],
      q,
    ),
);
endpoint(
  "post",
  "/integrations/fiscal/:id/retry",
  "integrations.manage",
  undefined,
  "Retry failed fiscal submission explicitly",
  (ctx, _i, req) => retryFiscal(ctx, idOf(req)),
);
endpoint(
  "get",
  "/offline/catalog-version",
  "sales.create",
  undefined,
  "Version token for conflict-aware offline capture",
  async (ctx) => ({ version: await catalogVersion(ctx) }),
);
endpoint(
  "post",
  "/offline/devices",
  ["offline.manage", "sales.price_override"],
  z
    .object({
      user_id: uuid,
      register_id: uuid,
      label: z.string().min(2).max(100),
      max_sale_amount: amount.refine((v) => D(v).gt(0)),
    })
    .strict(),
  "Explicitly authorize a cash-only offline capture device",
  async (ctx, i) => {
    await one(
      ctx,
      "SELECT id FROM identities WHERE company_id=$1 AND id=$2 AND status='active'",
      [ctx.companyId, i.user_id],
    );
    const r = await one(
      ctx,
      "SELECT * FROM registers WHERE company_id=$1 AND id=$2",
      [ctx.companyId, i.register_id],
    );
    branchAccess(ctx, r.branch_id);
    await warehouseAccess(ctx, r.warehouse_id);
    const membership = await ctx.db.query(
      "SELECT 1 FROM user_branches WHERE company_id=$1 AND user_id=$2 AND branch_id=$3",
      [ctx.companyId, i.user_id, r.branch_id],
    );
    if (!membership.rowCount)
      fail(
        422,
        "DEVICE_USER_BRANCH",
        "Device operator is not assigned to the branch",
      );
    const allowed = await ctx.db.query(
      "SELECT 1 FROM user_warehouses uw WHERE uw.company_id=$1 AND uw.user_id=$2 AND uw.warehouse_id=$3 AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.company_id=ur.company_id AND rp.role_id=ur.role_id WHERE ur.company_id=uw.company_id AND ur.user_id=uw.user_id AND rp.permission='sales.create')",
      [ctx.companyId, i.user_id, r.warehouse_id],
    );
    if (!allowed.rowCount)
      fail(
        422,
        "DEVICE_USER_SCOPE",
        "The operator needs sales-create permission and register warehouse membership",
      );
    const d = (
      await ctx.db.query(
        "INSERT INTO offline_devices(company_id,user_id,register_id,label,max_sale_amount) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [ctx.companyId, i.user_id, i.register_id, i.label, i.max_sale_amount],
      )
    ).rows[0];
    await audit(ctx, "authorize", "offline_device", d.id, null, d);
    return d;
  },
);
endpoint(
  "get",
  "/offline/devices",
  "sales.create",
  undefined,
  "Owned offline device authorizations",
  (ctx) =>
    ctx.db
      .query(
        "SELECT id,register_id,label,max_sale_amount,active FROM offline_devices WHERE company_id=$1 AND user_id=$2 ORDER BY label",
        [ctx.companyId, ctx.actor.id],
      )
      .then((r) => ({ items: r.rows })),
);
endpoint(
  "post",
  "/offline/devices/:id/revoke",
  ["offline.manage", "sales.price_override"],
  undefined,
  "Revoke an offline device",
  async (ctx, _i, req) => {
    const d = await one(
      ctx,
      "SELECT d.*,r.branch_id FROM offline_devices d JOIN registers r ON r.company_id=d.company_id AND r.id=d.register_id WHERE d.company_id=$1 AND d.id=$2",
      [ctx.companyId, idOf(req)],
    );
    branchAccess(ctx, d.branch_id);
    await ctx.db.query(
      "UPDATE offline_devices SET active=false WHERE company_id=$1 AND id=$2",
      [ctx.companyId, d.id],
    );
    await audit(ctx, "revoke", "offline_device", d.id);
    return { id: d.id, active: false };
  },
);
endpoint(
  "post",
  "/offline/sync",
  "sales.create",
  z
    .object({
      client_id: uuid,
      device_id: uuid,
      catalog_version: z.string().min(1).max(100),
      captured_at: z.iso.datetime(),
      captured_shift_id: uuid.optional(),
      accept_changes: z.boolean().default(false),
      sale: checkoutSchema,
    })
    .strict(),
  "Synchronize local cash capture, or persist a visible conflict",
  syncSale,
  { idempotent: false },
);
endpoint(
  "get",
  "/offline/sync",
  "sales.create",
  undefined,
  "Owned posted and conflicted client transactions",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT * ,count(*) OVER()::int AS _count FROM sync_records WHERE company_id=$1 AND user_id=$2 ORDER BY created_at DESC",
      [ctx.companyId, ctx.actor.id],
      q,
    ),
);
endpoint(
  "get",
  "/users",
  "users.manage",
  undefined,
  "User access and activation state",
  listUsers,
);
endpoint(
  "post",
  "/users",
  "users.manage",
  userSchema,
  "Create a user with scoped, non-escalating permissions",
  configureUser,
);
endpoint(
  "post",
  "/users/:id/access",
  "users.manage",
  z
    .object({
      status: z.enum(["active", "inactive", "suspended"]),
      role_ids: z.array(uuid).min(1),
      branch_ids: z.array(uuid).min(1),
      warehouse_ids: z.array(uuid),
      reason,
    })
    .strict(),
  "Change user roles, locations and activation; revoke sessions",
  (ctx, i, req) => setUserAccess(ctx, idOf(req), i),
);
endpoint(
  "post",
  "/roles",
  "users.manage",
  roleSchema,
  "Create configurable permission role",
  (ctx, i) => configureRole(ctx, i),
);
endpoint(
  "put",
  "/roles/:id",
  "users.manage",
  roleSchema,
  "Modify a role without self-escalation",
  (ctx, i, req) => configureRole(ctx, i, idOf(req)),
);
endpoint(
  "put",
  "/settings/company",
  "settings.manage",
  companySchema,
  "Update business, tax registration and safe operating controls",
  configureCompany,
);
endpoint(
  "get",
  "/setup/status",
  "settings.manage",
  undefined,
  "First-run readiness across business, receipt, accounting, payments, catalog, inventory and openings",
  setupStatus,
);
const masters: Record<
  string,
  {
    schema: z.ZodType;
    table: string;
    validate?: (ctx: Context, i: any) => Promise<void>;
    after?: (ctx: Context, row: any) => Promise<void>;
  }
> = {
  branches: {
    schema: z
      .object({
        name: z.string().min(2).max(100),
        code: z.string().regex(/^[A-Z0-9_-]{1,20}$/),
        address: z.string().max(500).optional(),
      })
      .strict(),
    table: "branches",
    after: async (ctx, r) => {
      await ctx.db.query(
        "INSERT INTO user_branches(company_id,user_id,branch_id) VALUES($1,$2,$3)",
        [ctx.companyId, ctx.actor.id, r.id],
      );
    },
  },
  warehouses: {
    schema: z
      .object({
        branch_id: uuid,
        name: z.string().min(2).max(100),
        code: z.string().regex(/^[A-Z0-9_-]{1,20}$/),
      })
      .strict(),
    table: "warehouses",
    validate: async (ctx, i) => branchAccess(ctx, i.branch_id),
    after: async (ctx, r) => {
      await ctx.db.query(
        "INSERT INTO user_warehouses(company_id,user_id,warehouse_id) VALUES($1,$2,$3)",
        [ctx.companyId, ctx.actor.id, r.id],
      );
    },
  },
  registers: {
    schema: z
      .object({
        branch_id: uuid,
        warehouse_id: uuid,
        name: z.string().min(2).max(100),
      })
      .strict(),
    table: "registers",
    validate: async (ctx, i) => {
      branchAccess(ctx, i.branch_id);
      const w = await warehouseAccess(ctx, i.warehouse_id);
      if (w.branch_id !== i.branch_id)
        fail(
          422,
          "REGISTER_WAREHOUSE_BRANCH",
          "Register and warehouse must belong to the same branch",
        );
    },
  },
  categories: {
    schema: z
      .object({ name: z.string().min(1).max(100), parent_id: uuid.optional() })
      .strict(),
    table: "categories",
  },
  units: {
    schema: z
      .object({
        name: z.string().min(1).max(100),
        symbol: z.string().min(1).max(20),
        fractional: z.boolean(),
      })
      .strict(),
    table: "units",
  },
  "price-lists": {
    schema: z.object({ name: z.string().min(1).max(100) }).strict(),
    table: "price_lists",
  },
  "tax-rules": {
    schema: z
      .object({
        name: z.string().min(1).max(100),
        code: z.string().min(1).max(30),
        rate: cost.refine((v) => D(v).lte(100)),
        kind: z.enum(["standard", "zero", "exempt", "non_taxable"]),
        valid_from: date,
        valid_to: date.optional(),
        version: z.number().int().min(1),
      })
      .strict()
      .refine(
        (v) =>
          (v.kind === "standard" || D(v.rate).eq(0)) &&
          (!v.valid_to || v.valid_to >= v.valid_from),
      ),
    table: "tax_rules",
  },
  "expense-categories": {
    schema: z
      .object({ name: z.string().min(1).max(100), account_id: uuid })
      .strict(),
    table: "expense_categories",
    validate: async (ctx, i) => {
      await one(
        ctx,
        "SELECT id FROM accounts WHERE company_id=$1 AND id=$2 AND type='expense'",
        [ctx.companyId, i.account_id],
      );
    },
  },
  "payment-methods": {
    schema: z
      .object({
        name: z.string().min(1).max(100),
        kind: z.enum(["cash", "mpesa", "bank", "card", "cheque", "other"]),
        account_id: uuid,
        requires_reference: z.boolean(),
      })
      .strict(),
    table: "payment_methods",
    validate: async (ctx, i) => {
      const a = await one(
        ctx,
        "SELECT * FROM accounts WHERE company_id=$1 AND id=$2 AND type='asset' AND active",
        [ctx.companyId, i.account_id],
      );
      if (
        [
          "ar",
          "inventory",
          "tax_input",
          "supplier_advances",
          "interbranch",
        ].includes(a.system_key)
      )
        fail(
          422,
          "PAYMENT_CONTROL_ACCOUNT",
          "Payment method requires a cash, bank or clearing account",
        );
      if (
        i.kind === "cash" &&
        (
          await ctx.db.query(
            "SELECT id FROM payment_methods WHERE company_id=$1 AND kind='cash'",
            [ctx.companyId],
          )
        ).rowCount
      )
        fail(
          409,
          "ONE_CASH_METHOD",
          "Use distinct registers rather than multiple physical cash tender methods",
        );
    },
  },
};
for (const [name, m] of Object.entries(masters))
  endpoint(
    "post",
    "/settings/" + name,
    "settings.manage",
    m.schema,
    "Configure " + name,
    async (ctx, i) => {
      if (m.validate) await m.validate(ctx, i);
      const keys = Object.keys(i),
        values = Object.values(i);
      const row = (
        await ctx.db.query(
          `INSERT INTO ${m.table}(company_id,${keys.join(",")}) VALUES($1,${values.map((_, n) => "$" + (n + 2)).join(",")}) RETURNING *`,
          [ctx.companyId, ...values],
        )
      ).rows[0];
      if (m.after) await m.after(ctx, row);
      await audit(ctx, "create", name, row.id, null, row);
      return row;
    },
  );
endpoint(
  "get",
  "/audit",
  "audits.read",
  undefined,
  "Append-only audit trail scoped to assigned branches",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT a.*,u.name AS actor,count(*) OVER()::int AS _count FROM audit_logs a JOIN identities u ON u.company_id=a.company_id AND u.id=a.actor_id WHERE a.company_id=$1 AND (a.branch_id IS NULL OR a.branch_id=ANY($2::uuid[])) AND (a.action ILIKE $3 OR a.entity ILIKE $3 OR u.name ILIKE $3) ORDER BY a.created_at DESC",
      [
        ctx.companyId,
        ctx.actor.branch_ids,
        `%${String(q.q ?? "").slice(0, 120)}%`,
      ],
      q,
    ),
);
endpoint(
  "get",
  "/security/events",
  "users.manage",
  undefined,
  "Security and session event log",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT action,ip,metadata,created_at,user_id,count(*) OVER()::int AS _count FROM security_events WHERE company_id=$1 ORDER BY created_at DESC",
      [ctx.companyId],
      q,
    ),
);
async function attachmentAccess(
  ctx: Context,
  entity: string,
  id: string,
  write = false,
) {
  if (entity === "company") {
    requirePermission(ctx, "settings.manage");
    if (id !== ctx.companyId) fail(404, "NOT_FOUND", "Business not found");
    return;
  }
  const spec: Record<string, [string, string, string]> = {
    product: ["products", "catalog.read", "catalog.write"],
    sale: ["sales", "sales.read", "sales.create"],
    expense: ["expenses", "expenses.read", "expenses.create"],
    purchase_order: ["purchase_orders", "purchases.read", "purchases.create"],
  };
  const s = spec[entity];
  if (!s) fail(422, "ATTACHMENT_ENTITY", "Unsupported attachment entity");
  requirePermission(ctx, s[write ? 2 : 1]);
  const r = await one(
    ctx,
    `SELECT * FROM ${s[0]} WHERE company_id=$1 AND id=$2`,
    [ctx.companyId, id],
  );
  if (r.branch_id) branchAccess(ctx, r.branch_id);
}
async function storeAttachment(ctx: Context, i: any) {
  await attachmentAccess(ctx, i.entity, i.record_id, true);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(i.base64))
    fail(422, "FILE_ENCODING", "Invalid base64 attachment");
  const b = Buffer.from(i.base64, "base64");
  if (!b.length || b.length > 5 * 1024 * 1024)
    fail(422, "FILE_SIZE", "Files must be 1 byte to 5 MiB");
  const valid =
    i.mime_type === "application/pdf"
      ? b.subarray(0, 5).toString() === "%PDF-"
      : i.mime_type === "image/png"
        ? b
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : b[0] === 255 && b[1] === 216 && b[2] === 255;
  if (!valid)
    fail(
      422,
      "FILE_SIGNATURE",
      "File content does not match its declared type",
    );
  const id = randomUUID(),
    key = ctx.companyId + "/" + id;
  const dir = process.env.UPLOAD_DIR ?? "uploads";
  const companyDir = path.join(dir, ctx.companyId);
  const created = await mkdir(companyDir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, key),
    file = await openFile(target, "wx", 0o600);
  // Register immediately: partial write/fsync failures also need rollback cleanup.
  ctx.onRollback(() =>
    unlink(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    }),
  );
  try {
    await file.writeFile(b);
    await file.sync();
  } finally {
    await file.close();
  }
  // Persist the byte file and newly created directory entries BEFORE DB metadata
  // can commit. Host filesystem/power-failure behavior still needs a real drill.
  const folders = new Set([
    companyDir,
    dir,
    ...(created ? [path.dirname(created)] : []),
  ]);
  for (const folder of folders) {
    const handle = await openFile(folder, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await ctx.db.query(
    "INSERT INTO attachments(id,company_id,entity,record_id,filename,storage_key,mime_type,size,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      id,
      ctx.companyId,
      i.entity,
      i.record_id,
      path.basename(i.filename),
      key,
      i.mime_type,
      b.length,
      ctx.actor.id,
    ],
  );
  await audit(ctx, "upload", "attachment", id, null, {
    entity: i.entity,
    record_id: i.record_id,
    mime_type: i.mime_type,
    size: b.length,
  });
  return { id, filename: path.basename(i.filename), size: b.length };
}
endpoint(
  "post",
  "/attachments",
  undefined,
  z
    .object({
      entity: z.enum([
        "company",
        "product",
        "sale",
        "expense",
        "purchase_order",
      ]),
      record_id: uuid,
      filename: z.string().min(1).max(200),
      mime_type: z.enum(["application/pdf", "image/png", "image/jpeg"]),
      base64: z.string().min(1).max(7000000),
    })
    .strict(),
  "Validated private receipt or product attachment",
  storeAttachment,
);
endpoint(
  "get",
  "/expenses/:id/attachments",
  "expenses.read",
  undefined,
  "Private receipt metadata for an authorized expense",
  async (ctx, _q, req) => {
    await attachmentAccess(ctx, "expense", idOf(req));
    return {
      items: (
        await ctx.db.query(
          "SELECT id,filename,mime_type,size,created_at FROM attachments WHERE company_id=$1 AND entity='expense' AND record_id=$2 ORDER BY created_at",
          [ctx.companyId, idOf(req)],
        )
      ).rows,
    };
  },
);
endpoint(
  "get",
  "/attachments/:id",
  undefined,
  undefined,
  "Authorized private file download",
  async (ctx, _q, req) => {
    const f = await one(
      ctx,
      "SELECT * FROM attachments WHERE company_id=$1 AND id=$2",
      [ctx.companyId, idOf(req)],
    );
    await attachmentAccess(ctx, f.entity, f.record_id);
    return {
      raw: await readFile(
        path.join(process.env.UPLOAD_DIR ?? "uploads", f.storage_key),
      ),
      contentType: f.mime_type,
      filename: f.filename,
    };
  },
);
endpoint(
  "get",
  "/pos/products/:id/availability",
  "sales.create",
  undefined,
  "Assigned-location batches, serials and stock version for checkout",
  async (ctx, q, req) => {
    if (!q.warehouse_id) fail(422, "WAREHOUSE_REQUIRED", "Select a warehouse");
    await warehouseAccess(ctx, q.warehouse_id);
    const p = await one(
      ctx,
      "SELECT id,kind,batch_tracked,serial_tracked FROM products WHERE company_id=$1 AND id=$2",
      [ctx.companyId, idOf(req)],
    );
    const stock = (
      await ctx.db.query(
        "SELECT quantity,reserved,version FROM stock_balances WHERE company_id=$1 AND product_id=$2 AND warehouse_id=$3",
        [ctx.companyId, p.id, q.warehouse_id],
      )
    ).rows[0] ?? { quantity: "0", reserved: "0", version: "0" };
    return {
      stock,
      batches: (
        await ctx.db.query(
          "SELECT id,batch_number,expiry_date,quantity FROM stock_batches WHERE company_id=$1 AND product_id=$2 AND warehouse_id=$3 AND quantity>0 ORDER BY expiry_date NULLS LAST,batch_number LIMIT 100",
          [ctx.companyId, p.id, q.warehouse_id],
        )
      ).rows,
      serials: (
        await ctx.db.query(
          "SELECT serial FROM serial_numbers WHERE company_id=$1 AND product_id=$2 AND warehouse_id=$3 AND status='available' ORDER BY serial LIMIT 100",
          [ctx.companyId, p.id, q.warehouse_id],
        )
      ).rows,
    };
  },
);
endpoint(
  "get",
  "/catalog/export",
  "catalog.read",
  undefined,
  "Export a bounded catalog page as Excel-compatible CSV",
  async (ctx, q) => {
    const result = await listProducts(ctx, q);
    return {
      raw: csv(
        result.items.map((p) => ({
          name: p.name,
          sku: p.sku,
          barcode: p.barcode,
          price: p.price,
          purchase_cost: p.purchase_cost,
          unit_id: p.unit_id,
          tax_rule_id: p.tax_rule_id,
          category_id: p.category_id,
          kind: p.kind,
        })),
      ),
      contentType: "text/csv; charset=utf-8",
      filename: `products-page-${result.page}.csv`,
    };
  },
);
for (const kind of ["customer", "supplier"] as const)
  endpoint(
    "get",
    "/" + kind + "s/:id/open-items",
    kind === "customer" ? "customers.read" : "suppliers.read",
    undefined,
    "Outstanding invoices for explicit payment allocation",
    async (ctx, q, req) => {
      const customer = kind === "customer";
      await one(
        ctx,
        `SELECT id FROM ${customer ? "customers" : "suppliers"} WHERE company_id=$1 AND id=$2`,
        [ctx.companyId, idOf(req)],
      );
      const balance = customer
        ? `s.total-s.paid_at_sale-coalesce((SELECT sum(a.amount) FROM customer_allocations a WHERE a.company_id=s.company_id AND a.sale_id=s.id),0)-coalesce((SELECT sum(r.credit_applied) FROM sale_returns r WHERE r.company_id=s.company_id AND r.sale_id=s.id),0)`
        : `supplier_invoice_balance(s.company_id,s.id)`;
      return pageQuery(
        ctx,
        `WITH items AS MATERIALIZED(SELECT s.id,s.number,s.total,s.due_date,(${balance}) AS outstanding,'invoice'::text AS document_type FROM ${customer ? "sales" : "supplier_invoices"} s WHERE s.company_id=$1 AND s.${customer ? "customer_id" : "supplier_id"}=$2 AND s.branch_id=ANY($3::uuid[])
 UNION ALL SELECT i.id,b.number||' · '||i.reference,i.amount,i.due_date,opening_item_balance(i.company_id,i.id),'opening' FROM opening_items i JOIN opening_batches b ON b.company_id=i.company_id AND b.id=i.batch_id WHERE i.company_id=$1 AND i.${customer ? "customer_id" : "supplier_id"}=$2 AND i.kind='${kind}' AND i.direction='debt' AND b.status='posted' AND b.branch_id=ANY($3::uuid[])) SELECT id,number,total,due_date,outstanding::text,document_type,count(*) OVER()::int AS _count FROM items WHERE outstanding>0 AND ($4::text IS NULL OR document_type=$4) ORDER BY due_date,number,id`,
        [
          ctx.companyId,
          idOf(req),
          ctx.actor.branch_ids,
          q.document_type ?? null,
        ],
        q,
      );
    },
  );
endpoint(
  "get",
  "/purchases/invoices/:id",
  "purchases.read",
  undefined,
  "Supplier invoice with GRN match and return quantities",
  async (ctx, _q, req) => {
    const i = await one(
      ctx,
      "SELECT s.*,c.name AS supplier,supplier_invoice_balance(s.company_id,s.id)::text AS outstanding FROM supplier_invoices s JOIN suppliers c ON c.company_id=s.company_id AND c.id=s.supplier_id WHERE s.company_id=$1 AND s.id=$2",
      [ctx.companyId, idOf(req)],
    );
    branchAccess(ctx, i.branch_id);
    const grn = await getGoodsReceipt(ctx, i.receipt_id);
    return {
      ...i,
      grn,
      credit_settlements: (
        await ctx.db.query(
          `SELECT c.*,f.number AS from_invoice,t.number AS to_invoice,p.method_id,p.reference,m.name AS method,v.id AS reversed_by FROM supplier_credit_settlements c JOIN supplier_invoices f ON f.company_id=c.company_id AND f.id=c.from_invoice_id LEFT JOIN supplier_invoices t ON t.company_id=c.company_id AND t.id=c.to_invoice_id LEFT JOIN payments p ON p.company_id=c.company_id AND p.id=c.payment_id LEFT JOIN payment_methods m ON m.company_id=p.company_id AND m.id=p.method_id LEFT JOIN supplier_credit_settlements v ON v.company_id=c.company_id AND v.reversal_of=c.id WHERE c.company_id=$1 AND (c.from_invoice_id=$2 OR c.to_invoice_id=$2) ORDER BY c.created_at,c.number`,
          [ctx.companyId, i.id],
        )
      ).rows,
      lines: (
        await ctx.db.query(
          "SELECT l.*,g.quantity,g.product_id,p.name,p.serial_tracked,p.batch_tracked,coalesce((SELECT sum(quantity) FROM supplier_return_lines r WHERE r.company_id=l.company_id AND r.receipt_line_id=l.receipt_line_id),0)::text AS returned FROM supplier_invoice_lines l JOIN goods_receipt_lines g ON g.company_id=l.company_id AND g.id=l.receipt_line_id JOIN products p ON p.company_id=g.company_id AND p.id=g.product_id WHERE l.company_id=$1 AND l.invoice_id=$2",
          [ctx.companyId, i.id],
        )
      ).rows,
    };
  },
);
endpoint(
  "get",
  "/inventory/documents",
  "inventory.read",
  undefined,
  "Audited stock documents and counts",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT d.*,w.name AS warehouse,count(*) OVER()::int AS _count FROM stock_documents d JOIN warehouses w ON w.company_id=d.company_id AND w.id=d.warehouse_id WHERE d.company_id=$1 AND d.branch_id=ANY($2::uuid[]) AND d.warehouse_id=ANY($3::uuid[]) ORDER BY d.created_at DESC",
      [ctx.companyId, ctx.actor.branch_ids, ctx.actor.warehouse_ids],
      q,
    ),
);
endpoint(
  "get",
  "/integrations/config",
  "integrations.manage",
  undefined,
  "Masked per-company integration configuration state (values never returned)",
  (ctx) => integrationConfigStatus(ctx),
);
endpoint(
  "put",
  "/integrations/config",
  "integrations.manage",
  z
    .object({
      provider: z.enum(["mpesa", "etims"]),
      enabled: z.boolean(),
      config: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  "Configure provider credentials or toggle enablement; secrets write-only",
  async (ctx, i) => {
    if (i.config)
      return saveIntegrationConfig(ctx, i.provider, i.config, i.enabled);
    return setIntegrationEnabled(ctx, i.provider, i.enabled);
  },
);
endpoint(
  "get",
  "/integrations/status",
  "integrations.manage",
  undefined,
  "Integration mode and configuration readiness without secrets",
  async () => ({
    mpesa_mode: process.env.MPESA_MODE ?? "disabled",
    fiscal_mode: process.env.ETIMS_MODE ?? "disabled",
    mpesa_credentials_configured: !!(
      process.env.MPESA_CONSUMER_KEY &&
      process.env.MPESA_CONSUMER_SECRET &&
      process.env.MPESA_SHORTCODE &&
      process.env.MPESA_PASSKEY &&
      process.env.MPESA_CALLBACK_SECRET
    ),
    fiscal_adapter_configured: !!(
      process.env.ETIMS_ADAPTER_URL && process.env.ETIMS_ADAPTER_TOKEN
    ),
    production: process.env.NODE_ENV === "production",
  }),
);
endpoint(
  "get",
  "/integrations/mpesa",
  "integrations.manage",
  undefined,
  "Mobile money intents and reconciliation state",
  (ctx, q) =>
    pageQuery(
      ctx,
      "SELECT id,amount,provider,status,checkout_id,receipt_number,consumed_by,last_error,created_at,count(*) OVER()::int AS _count FROM payment_intents WHERE company_id=$1 AND branch_id=ANY($2::uuid[]) ORDER BY created_at DESC",
      [ctx.companyId, ctx.actor.branch_ids],
      q,
    ),
);
endpoint(
  "get",
  "/products/:id/attachments",
  "catalog.read",
  undefined,
  "Private product image and attachment references",
  async (ctx, _q, req) => {
    await one(ctx, "SELECT id FROM products WHERE company_id=$1 AND id=$2", [
      ctx.companyId,
      idOf(req),
    ]);
    return {
      items: (
        await ctx.db.query(
          "SELECT id,filename,mime_type,size FROM attachments WHERE company_id=$1 AND entity='product' AND record_id=$2 ORDER BY created_at DESC LIMIT 20",
          [ctx.companyId, idOf(req)],
        )
      ).rows,
    };
  },
);
endpoint(
  "get",
  "/accounting/bank-reconciliations",
  "accounting.read",
  undefined,
  "Company-wide confirmed bank statement matches",
  async (ctx, q) => {
    await requireAllBranches(ctx);
    return pageQuery(
      ctx,
      "SELECT r.*,a.name AS account,count(*) OVER()::int AS _count FROM bank_reconciliations r JOIN accounts a ON a.company_id=r.company_id AND a.id=r.account_id WHERE r.company_id=$1 ORDER BY r.statement_date DESC,r.id",
      [ctx.companyId],
      q,
    );
  },
);
endpoint(
  "get",
  "/accounting/bank-unmatched",
  "accounting.read",
  undefined,
  "Paginated unmatched company-wide bank ledger lines",
  async (ctx, q) => {
    await requireAllBranches(ctx);
    if (!q.account_id) fail(422, "ACCOUNT_REQUIRED", "Select an account");
    return pageQuery(
      ctx,
      "SELECT l.id,l.debit,l.credit,j.number,j.accounting_date,j.description,count(*) OVER()::int AS _count FROM journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=$1 AND l.account_id=$2 AND ($3::date IS NULL OR j.accounting_date<=$3) AND NOT EXISTS(SELECT 1 FROM bank_reconciliation_lines r WHERE r.company_id=l.company_id AND r.journal_line_id=l.id) ORDER BY j.accounting_date,j.created_at,l.id",
      [ctx.companyId, q.account_id, q.to ?? null],
      q,
    );
  },
);
endpoint(
  "get",
  "/accounting/budgets",
  "accounting.read",
  undefined,
  "Branch budget versus posted expense activity",
  (ctx, q) =>
    pageQuery(
      ctx,
      `SELECT b.*,br.name AS branch,a.name AS account,p.name AS period,coalesce((SELECT sum(l.debit-l.credit) FROM journal_lines l JOIN journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=b.company_id AND l.account_id=b.account_id AND j.branch_id=b.branch_id AND j.accounting_date BETWEEN p.start_date AND p.end_date),0)::text AS actual,count(*) OVER()::int AS _count FROM budgets b JOIN branches br ON br.company_id=b.company_id AND br.id=b.branch_id JOIN accounts a ON a.company_id=b.company_id AND a.id=b.account_id JOIN accounting_periods p ON p.company_id=b.company_id AND p.id=b.period_id WHERE b.company_id=$1 AND b.branch_id=ANY($2::uuid[]) ORDER BY p.start_date DESC,br.name,a.code`,
      [ctx.companyId, ctx.actor.branch_ids],
      q,
    ),
);

endpoint(
  "get",
  "/pos/orders/:id",
  "sales.create",
  undefined,
  "Load approved reserved order for POS fulfilment",
  async (ctx, _q, req) => {
    const order = await one(
      ctx,
      "SELECT * FROM business_documents WHERE company_id=$1 AND id=$2 AND kind='sales_order' AND status='approved'",
      [ctx.companyId, idOf(req)],
    );
    branchAccess(ctx, order.branch_id);
    await warehouseAccess(ctx, order.warehouse_id);
    const customer = order.customer_id
      ? await one(
          ctx,
          "SELECT id,name,credit_limit FROM customers WHERE company_id=$1 AND id=$2 AND active",
          [ctx.companyId, order.customer_id],
        )
      : null;
    const lines = [];
    for (const l of order.lines) {
      const p = await one(
        ctx,
        "SELECT sku FROM products WHERE company_id=$1 AND id=$2",
        [ctx.companyId, l.product_id],
      );
      const matches = await listProducts(ctx, {
        q: p.sku,
        warehouse_id: order.warehouse_id,
        limit: 100,
      });
      const product = matches.items.find((p) => p.id === l.product_id);
      if (!product)
        fail(
          409,
          "ORDER_PRODUCT_UNAVAILABLE",
          "An order product is no longer active",
        );
      lines.push({
        product_id: l.product_id,
        quantity: l.quantity,
        unit_id: l.unit_id,
        batch_id: l.batch_id,
        serials: l.serials ?? [],
        product,
      });
    }
    return {
      id: order.id,
      number: order.number,
      warehouse_id: order.warehouse_id,
      branch_id: order.branch_id,
      customer,
      lines,
    };
  },
);

const creditPayment = z
  .object({
    method_id: uuid,
    reference: z.string().min(1).max(120).optional(),
    intent_id: uuid.optional(),
  })
  .strict();
endpoint(
  "post",
  "/purchases/credits/settle",
  "payments.pay",
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("offset"),
        invoice_id: uuid,
        target_invoice_id: uuid,
        amount: amount.refine((v) => D(v).gt(0)),
        reason,
        accounting_date: date.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("refund"),
        invoice_id: uuid,
        amount: amount.refine((v) => D(v).gt(0)),
        payment: creditPayment,
        shift_id: uuid.optional(),
        reason,
        accounting_date: date.optional(),
      })
      .strict(),
  ]),
  "Apply an available supplier credit to another invoice or record its actual incoming refund",
  settleSupplierCredit,
);
endpoint(
  "post",
  "/purchases/credits/:id/reverse",
  "payments.pay",
  z
    .object({
      reason,
      payment: creditPayment.optional(),
      shift_id: uuid.optional(),
      accounting_date: date.optional(),
    })
    .strict(),
  "Reverse a supplier credit allocation/refund through an append-only correction",
  (ctx, i, req) => reverseSupplierCredit(ctx, idOf(req), i),
);

endpoint(
  "post",
  "/sales/recovery/cancel",
  "sales.create",
  z.object({ key: z.string().min(8).max(160), reason }).strict(),
  "Recover an already posted checkout, or persist a permanent cancellation tombstone for an unposted intention",
  cancelUncertainCheckout,
  { idempotent: false },
);

const expenseRefundPayment = z
  .object({
    method_id: uuid,
    reference: z.string().min(1).max(120).optional(),
    intent_id: uuid.optional(),
  })
  .strict();
endpoint(
  "get",
  "/expenses/:id",
  "expenses.read",
  undefined,
  "Expense original voucher, actual posting date and immutable refund/repayment history",
  (ctx, _q, req) => getExpense(ctx, idOf(req)),
);
endpoint(
  "post",
  "/expenses/:id/refunds",
  "expenses.pay",
  z
    .object({
      amount: amount.refine((v) => D(v).gt(0)),
      payment: expenseRefundPayment,
      shift_id: uuid.optional(),
      reason,
      accounting_date: date.optional(),
    })
    .strict(),
  "Record an actually received expense refund against original posted net/tax snapshots",
  (ctx, i, req) => refundExpense(ctx, idOf(req), i),
);
endpoint(
  "post",
  "/expenses/refunds/:id/reverse",
  "expenses.pay",
  z
    .object({
      payment: expenseRefundPayment,
      shift_id: uuid.optional(),
      reason,
      accounting_date: date.optional(),
    })
    .strict(),
  "Record actual outgoing repayment of an expense refund; no external transfer is cancelled",
  (ctx, i, req) => reverseExpenseRefund(ctx, idOf(req), i),
);

endpoint(
  "get",
  "/accounting/opening-metadata",
  "accounting.read",
  undefined,
  "Fixed branch cutover and earliest debt activity, without inventing operational invoices",
  (ctx, q) => {
    if (!q.branch_id)
      fail(422, "OPENING_BRANCH", "Choose one branch for its cutover policy");
    return openingMetadata(ctx, q.branch_id);
  },
);
endpoint(
  "get",
  "/accounting/opening-batches",
  "accounting.read",
  undefined,
  "Draft, posted and reversed legacy AR/AP migration batches",
  listOpeningBatches,
);
endpoint(
  "get",
  "/accounting/opening-batches/:id",
  "accounting.read",
  undefined,
  "Opening carry-forward detail, original legacy references and remaining items",
  (ctx, _q, req) => getOpeningBatch(ctx, idOf(req)),
);
endpoint(
  "post",
  "/accounting/opening-batches",
  "accounting.post",
  openingBatchSchema,
  "Create an unposted reviewed migration draft; no fake sales/VAT/stock",
  (ctx, i) => saveOpeningBatch(ctx, i),
);
endpoint(
  "put",
  "/accounting/opening-batches/:id",
  "accounting.post",
  openingBatchSchema,
  "Edit draft carry-forward only; submitted/posted items are immutable",
  (ctx, i, req) => saveOpeningBatch(ctx, i, idOf(req)),
);
endpoint(
  "post",
  "/accounting/opening-batches/:id/transition",
  "accounting.post",
  z
    .object({ status: z.enum(["submitted", "draft", "cancelled"]), reason })
    .strict(),
  "Submit for approval, return unposted draft or cancel unposted batch",
  (ctx, i, req) => transitionOpeningBatch(ctx, idOf(req), i.status, i.reason),
);
endpoint(
  "post",
  "/accounting/opening-batches/:id/post",
  "accounting.close",
  z.object({ reason }).strict(),
  "Approve/post positive legacy AR/AP at fixed cutover against equity only",
  (ctx, i, req) => postOpeningBatch(ctx, idOf(req), i.reason),
);
endpoint(
  "post",
  "/accounting/opening-batches/:id/reverse",
  "accounting.reverse",
  z.object({ reason, accounting_date: date.optional() }).strict(),
  "Reverse an unconsumed opening batch append-only; never undo real settlements",
  (ctx, i, req) => reverseOpeningBatch(ctx, idOf(req), i),
);
endpoint(
  "post",
  "/accounting/opening-items/:id/apply-credit",
  undefined,
  z
    .object({
      credit_id: uuid,
      amount: amount.refine((v) => D(v).gt(0)),
      reason,
      accounting_date: date.optional(),
    })
    .strict(),
  "Apply an already booked party/branch advance to an opening debt without moving cash",
  (ctx, i, req) => applyCreditToOpening(ctx, idOf(req), i),
);
