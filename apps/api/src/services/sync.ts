/**
 * ERP synchronisation.
 *
 * Every push is a durable job with a deterministic idempotency key, an attempt
 * counter, exponential backoff and a matching `erp_sync_log` row. A job can only
 * become `succeeded` after a real ERP response; unsupported ERP capabilities end
 * as `dead` with the requested contract named.
 */
import type { Database, Queryable } from "../db/index.ts";
import type { ErpAdapter } from "@ecom/erp-adapter";
import { ErpError } from "@ecom/erp-adapter";
import { config } from "../config.ts";
import { erpImageUrl, isErpImageUrl } from "./product-images.ts";
import { logger } from "../logger.ts";
import { audit } from "./security.ts";
import { slugify, toMoney } from "@ecom/shared";

export interface SyncJobInput {
  entityType: string;
  direction: "pull" | "push";
  operation: string;
  localId: string | number;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  maxAttempts?: number;
}

export function syncKey(operation: string, localId: string | number): string {
  return `ecommerce:${operation}:${String(localId).replace(/[^A-Za-z0-9._:-]/g, "-")}`.slice(
    0,
    150,
  );
}

export async function enqueueSyncJob(db: Queryable, input: SyncJobInput) {
  const key = input.idempotencyKey ?? syncKey(input.operation, input.localId);
  const inserted = await db.query<any>(
    `INSERT INTO erp_sync_job(entity_type, direction, operation, idempotency_key, payload, max_attempts)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING job_id, status, operation`,
    [
      input.entityType,
      input.direction,
      input.operation,
      key,
      JSON.stringify(input.payload ?? {}),
      input.maxAttempts ?? 5,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await db.query<any>(
    "SELECT job_id, status, operation FROM erp_sync_job WHERE idempotency_key = $1",
    [key],
  );
  return existing.rows[0];
}

async function startLog(
  db: Queryable,
  input: {
    key: string;
    entityType: string;
    direction: string;
    operation: string;
    attempt: number;
  },
) {
  const logKey = `${input.key}:attempt:${input.attempt}`.slice(0, 160);
  const inserted = await db.query<{ log_id: string }>(
    `INSERT INTO erp_sync_log(entity_type, direction, operation, idempotency_key, status, attempts)
     VALUES($1,$2,$3,$4,'in_progress',$5)
     ON CONFLICT (idempotency_key) DO UPDATE SET status='in_progress', attempts=$5, started_at=now()
     RETURNING log_id`,
    [input.entityType, input.direction, input.operation, logKey, input.attempt],
  );
  return inserted.rows[0]!.log_id;
}

async function finishLog(
  db: Queryable,
  logId: string,
  outcome: {
    status: "succeeded" | "failed" | "skipped";
    summary?: unknown;
    error?: ErpError | Error;
    /** Machine-readable ERP code, retained even when only the message survives. */
    errorCode?: string;
    httpStatus?: number;
  },
) {
  const erp = outcome.error instanceof ErpError ? outcome.error : null;
  await db.query(
    `UPDATE erp_sync_log SET status=$2, response_summary=$3, error_code=$4, error_message=$5,
            http_status=$6, finished_at=now()
      WHERE log_id=$1`,
    [
      logId,
      outcome.status,
      JSON.stringify(outcome.summary ?? null),
      outcome.errorCode ?? erp?.erpCode ?? erp?.code ?? null,
      outcome.error ? String(outcome.error.message).slice(0, 500) : null,
      outcome.httpStatus ?? erp?.status ?? null,
    ],
  );
}

function retryDelayMs(attempt: number) {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
}

export interface JobOutcome {
  status: "succeeded" | "retry" | "dead";
  summary?: unknown;
  error?: string;
  errorCode?: string;
}

/** Claims one due job atomically so multiple workers never run it twice. */
export async function claimDueSyncJob(db: Queryable) {
  const claimed = await db.query<any>(
    `UPDATE erp_sync_job
        SET status = 'processing', locked_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE job_id = (
        SELECT job_id FROM erp_sync_job
         WHERE status IN ('pending','retry') AND next_attempt_at <= now()
         ORDER BY next_attempt_at, job_id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING job_id, entity_type, direction, operation, idempotency_key, payload, attempts, max_attempts`,
  );
  return claimed.rows[0] ?? null;
}

export async function completeSyncJob(
  db: Queryable,
  job: any,
  outcome: JobOutcome,
  logId?: string,
) {
  if (outcome.status === "succeeded") {
    await db.query(
      "UPDATE erp_sync_job SET status='succeeded', last_error=NULL, locked_at=NULL, next_attempt_at=now() WHERE job_id=$1",
      [job.job_id],
    );
  } else if (outcome.status === "retry" && job.attempts < job.max_attempts) {
    await db.query(
      `UPDATE erp_sync_job SET status='retry', last_error=$2, locked_at=NULL,
              next_attempt_at = now() + ($3 || ' milliseconds')::interval
        WHERE job_id=$1`,
      [
        job.job_id,
        String(outcome.error ?? "retry").slice(0, 500),
        String(retryDelayMs(job.attempts)),
      ],
    );
  } else {
    await db.query(
      "UPDATE erp_sync_job SET status='dead', last_error=$2, locked_at=NULL WHERE job_id=$1",
      [job.job_id, String(outcome.error ?? "failed").slice(0, 500)],
    );
  }
  if (logId) {
    await finishLog(db, logId, {
      status: outcome.status === "succeeded" ? "succeeded" : "failed",
      summary: outcome.summary,
      error: outcome.error ? new Error(outcome.error) : undefined,
      errorCode: outcome.errorCode,
    });
  }
}

// ---------------------------------------------------------------------------
// Pull: catalogue
// ---------------------------------------------------------------------------
export async function pullCatalog(db: Database, adapter: ErpAdapter) {
  const runId = `catalog-${Date.now()}`;
  let products = 0;
  let variants = 0;
  let brands = 0;
  let categories = 0;

  await db.withTransaction(async (tx) => {
    for await (const erpProduct of adapter.iterateProducts(100)) {
      let brandId: number | null = null;
      if (erpProduct.brand) {
        const brand = await tx.query<{ brand_id: number }>(
          `INSERT INTO brand(brand_name, slug) VALUES($1,$2)
           ON CONFLICT (brand_name) DO UPDATE SET updated_at = now()
           RETURNING brand_id`,
          [
            erpProduct.brand.slice(0, 120),
            slugify(erpProduct.brand).slice(0, 140) ||
              `brand-${erpProduct.id.slice(0, 8)}`,
          ],
        );
        brandId = brand.rows[0]!.brand_id;
        brands += 1;
      }

      let categoryId: number | null = null;
      if (erpProduct.category) {
        const slug =
          slugify(erpProduct.category).slice(0, 140) ||
          `category-${erpProduct.category_id?.slice(0, 8) ?? "unknown"}`;
        const category = await tx.query<{ category_id: number }>(
          `INSERT INTO category(category_name, slug) VALUES($1,$2)
           ON CONFLICT (slug) WHERE slug IS NOT NULL DO UPDATE SET category_name = EXCLUDED.category_name, updated_at = now()
           RETURNING category_id`,
          [erpProduct.category.slice(0, 100), slug],
        );
        categoryId = category.rows[0]!.category_id;
        categories += 1;
      }

      const mapped = await tx.query<{ local_id: string }>(
        "SELECT local_id FROM erp_entity_map WHERE entity_type IN ('product','variant') AND erp_id = $1 LIMIT 1",
        [erpProduct.id],
      );
      const isVariant = Boolean(erpProduct.parent_id);

      if (!isVariant) {
        let productId: number;
        if (mapped.rows[0]) {
          productId = Number(mapped.rows[0].local_id);
          await tx.query(
            `UPDATE product SET product_name=$2, description=$3, brand=$4, brand_id=$5,
                    status = CASE WHEN $6::boolean THEN 'active' ELSE 'archived' END,
                    updated_at=now(), erp_updated_at=now(), sync_state='synced'
              WHERE product_id=$1`,
            [
              productId,
              erpProduct.name.slice(0, 255),
              erpProduct.description,
              erpProduct.brand,
              brandId,
              erpProduct.active,
            ],
          );
          products += 1;
        } else {
          const slug =
            `${slugify(erpProduct.name)}-${slugify(erpProduct.sku)}`.slice(
              0,
              180,
            );
          const inserted = await tx.query<{ product_id: number }>(
            `INSERT INTO product(product_name, description, brand, brand_id, slug, status, summary, sync_state, erp_updated_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,'synced',now())
             RETURNING product_id`,
            [
              erpProduct.name.slice(0, 255),
              erpProduct.description,
              erpProduct.brand,
              brandId,
              slug,
              erpProduct.active ? "active" : "archived",
              erpProduct.description?.slice(0, 400) ?? null,
            ],
          );
          productId = inserted.rows[0]!.product_id;
          products += 1;
        }
        await syncProductImage(tx, {
          productId,
          attachmentId: erpProduct.image_attachment_id ?? null,
          productName: erpProduct.name,
        });
        await tx.query(
          `INSERT INTO erp_entity_map(entity_type, local_id, erp_id, metadata, last_synced_at)
           VALUES('product',$1,$2,$3,now())
           ON CONFLICT (entity_type, local_id) DO UPDATE SET erp_id = EXCLUDED.erp_id, last_synced_at = now(), metadata = EXCLUDED.metadata`,
          [
            String(productId),
            erpProduct.id,
            JSON.stringify({ sku: erpProduct.sku }),
          ],
        );
        if (categoryId) {
          await tx.query(
            "INSERT INTO product_category(product_id, category_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [productId, categoryId],
          );
        }
        const variant = await syncVariant(tx, {
          productId,
          erpProduct,
          isDefault: true,
        });
        variants += 1;
      } else {
        const parentMap = await tx.query<{ local_id: string }>(
          "SELECT local_id FROM erp_entity_map WHERE entity_type = 'product' AND erp_id = $1 LIMIT 1",
          [erpProduct.parent_id],
        );
        if (!parentMap.rows[0]) {
          throw new ErpError(
            "ERP_PROTOCOL",
            `ERP variant ${erpProduct.sku} references parent ${erpProduct.parent_id}, which is not mapped. Pull the parent product first.`,
          );
        }
        const productId = Number(parentMap.rows[0].local_id);
        const variant = await syncVariant(tx, {
          productId,
          erpProduct,
          isDefault: false,
        });
        variants += 1;
      }
    }

    await tx.query(
      `INSERT INTO app_setting(key, value) VALUES('erp.last_catalog_sync', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [
        JSON.stringify({
          at: new Date().toISOString(),
          run_id: runId,
          products,
          variants,
        }),
      ],
    );
  });

  const summary = { products, variants, brands, categories };
  await db.query(
    `INSERT INTO erp_sync_log(entity_type, direction, operation, idempotency_key, status, attempts,
                              response_summary, started_at, finished_at)
     VALUES('catalog','pull','pull_catalog',$1,'succeeded',1,$2, now(), now())
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [runId.slice(0, 160), JSON.stringify(summary)],
  );
  return { run_id: runId, ...summary };
}

/**
 * Record (or refresh) the ERP photo as the product's primary image.
 *
 * The URL is the shop's own proxy path, so the browser loads it from the shop
 * and this API fetches the bytes from the ERP on demand. Images an operator set
 * by hand (absolute http(s) URLs) are left alone: the ERP only replaces its own.
 */
async function syncProductImage(
  tx: Queryable,
  input: {
    productId: number;
    attachmentId: string | null;
    productName: string;
  },
): Promise<void> {
  if (!input.attachmentId) return;
  const url = erpImageUrl(input.attachmentId);
  const primary = await tx.query<{ image_id: number; image_url: string }>(
    "SELECT image_id, image_url FROM product_image WHERE product_id = $1 ORDER BY is_primary DESC, sort_order, image_id LIMIT 1",
    [input.productId],
  );
  const current = primary.rows[0];
  if (!current) {
    await tx.query(
      `INSERT INTO product_image(product_id, image_url, alt_text, is_primary, sort_order)
       VALUES($1,$2,$3,true,1)`,
      [input.productId, url, input.productName.slice(0, 255)],
    );
    return;
  }
  if (current.image_url !== url && isErpImageUrl(current.image_url)) {
    await tx.query(
      "UPDATE product_image SET image_url = $2, alt_text = $3 WHERE image_id = $1",
      [current.image_id, url, input.productName.slice(0, 255)],
    );
  }
}

async function syncVariant(
  tx: Queryable,
  input: { productId: number; erpProduct: any; isDefault: boolean },
): Promise<"created" | "updated"> {
  const { productId, erpProduct, isDefault } = input;
  const existing = await tx.query<{ local_id: string }>(
    "SELECT local_id FROM erp_entity_map WHERE entity_type = 'variant' AND erp_id = $1",
    [erpProduct.id],
  );

  if (existing.rows[0]) {
    const variantId = Number(existing.rows[0].local_id);
    await tx.query(
      `UPDATE product_variant SET sku=$2, price=$3, barcode=$4, is_active=$5, updated_at=now()
        WHERE variant_id=$1`,
      [
        variantId,
        erpProduct.sku.slice(0, 50),
        toMoney(erpProduct.price),
        erpProduct.barcode,
        erpProduct.active,
      ],
    );
    await tx.query(
      "UPDATE erp_entity_map SET last_synced_at=now() WHERE entity_type='variant' AND local_id=$1",
      [String(variantId)],
    );
    return "updated";
  }

  const hasDefault = await tx.query(
    "SELECT 1 FROM product_variant WHERE product_id = $1 AND is_default LIMIT 1",
    [productId],
  );
  const variant = await tx.query<{ variant_id: number }>(
    `INSERT INTO product_variant(product_id, sku, price, qty_in_stock, barcode, is_default, is_active)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING variant_id`,
    [
      productId,
      erpProduct.sku.slice(0, 50),
      toMoney(erpProduct.price),
      Math.max(priceNumber(erpProduct.stock), 0),
      erpProduct.barcode,
      isDefault && hasDefault.rowCount === 0,
      erpProduct.active,
    ],
  );
  const variantId = variant.rows[0]!.variant_id;
  await tx.query(
    `INSERT INTO erp_entity_map(entity_type, local_id, erp_id, metadata, last_synced_at)
     VALUES('variant',$1,$2,$3,now())
     ON CONFLICT (entity_type, local_id) DO UPDATE SET erp_id = EXCLUDED.erp_id, last_synced_at = now()`,
    [
      String(variantId),
      erpProduct.id,
      JSON.stringify({ sku: erpProduct.sku, is_variant_of: productId }),
    ],
  );
  return "created";
}

function priceNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Pull: inventory
// ---------------------------------------------------------------------------
export async function pullInventory(db: Database, adapter: ErpAdapter) {
  const runId = `inventory-${Date.now()}`;
  let updated = 0;
  let skipped = 0;

  await db.withTransaction(async (tx) => {
    for await (const row of adapter.iterateInventory(
      100,
      config.erp.defaultWarehouseId || undefined,
    )) {
      const mapped = await tx.query<{ local_id: string }>(
        "SELECT local_id FROM erp_entity_map WHERE entity_type = 'variant' AND erp_id = $1",
        [row.product_id],
      );
      if (!mapped.rows[0]) {
        skipped += 1;
        continue;
      }
      const variantId = Number(mapped.rows[0].local_id);
      const current = await tx.query<{ qty_in_stock: number }>(
        "SELECT qty_in_stock FROM product_variant WHERE variant_id = $1 FOR UPDATE",
        [variantId],
      );
      if (!current.rows[0]) {
        skipped += 1;
        continue;
      }
      const next = Math.max(0, priceNumber(row.quantity));
      const delta = next - Number(current.rows[0].qty_in_stock);
      if (delta !== 0) {
        await tx.query(
          "UPDATE product_variant SET qty_in_stock = $2, updated_at = now() WHERE variant_id = $1",
          [variantId, next],
        );
        await tx.query(
          `INSERT INTO inventory_movement(variant_id, quantity_delta, quantity_after, reason, source_type, source_id, actor, note)
           VALUES($1,$2,$3,'erp_sync','erp_sync',$4,'erp', 'Stock aligned from ERP inventory balances')
           ON CONFLICT DO NOTHING`,
          [variantId, delta, next, runId],
        );
        updated += 1;
      }
      await tx.query(
        `UPDATE erp_entity_map SET metadata = $2, last_synced_at = now()
          WHERE entity_type = 'variant' AND local_id = $1`,
        [
          String(variantId),
          JSON.stringify({
            erp_reserved: row.reserved ?? null,
            erp_available: row.available ?? null,
            erp_version: row.version ?? null,
            warehouse_id: row.warehouse_id,
          }),
        ],
      );
    }

    await tx.query(
      `INSERT INTO app_setting(key, value) VALUES('erp.last_inventory_sync', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [
        JSON.stringify({
          at: new Date().toISOString(),
          run_id: runId,
          updated,
          skipped,
        }),
      ],
    );
  });

  await db.query(
    `INSERT INTO erp_sync_log(entity_type, direction, operation, idempotency_key, status, attempts,
                              response_summary, started_at, finished_at)
     VALUES('inventory','pull','pull_inventory',$1,'succeeded',1,$2, now(), now())
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [runId.slice(0, 160), JSON.stringify({ updated, skipped })],
  );
  return { run_id: runId, updated, skipped };
}

// ---------------------------------------------------------------------------
// Push: order document, payment, refund
// ---------------------------------------------------------------------------
export async function pushOrderDocument(
  db: Database,
  adapter: ErpAdapter,
  orderId: number,
) {
  return db.withTransaction(async (tx) => {
    const orders = await tx.query<any>(
      `SELECT o.order_id, o.order_number, o.customer_id, o.email, o.order_total::text AS total
         FROM customer_order o WHERE o.order_id = $1`,
      [orderId],
    );
    const order = orders.rows[0];
    if (!order) throw new Error(`Order ${orderId} no longer exists`);

    const existing = await tx.query<{ erp_id: string; metadata: any }>(
      "SELECT erp_id, metadata FROM erp_entity_map WHERE entity_type = 'order' AND local_id = $1",
      [String(orderId)],
    );
    if (existing.rows[0])
      return { skipped: true, erp_id: existing.rows[0].erp_id };

    let erpCustomerId: string | undefined;
    if (order.customer_id) {
      const customerMap = await tx.query<{ erp_id: string }>(
        "SELECT erp_id FROM erp_entity_map WHERE entity_type = 'customer' AND local_id = $1",
        [String(order.customer_id)],
      );
      erpCustomerId = customerMap.rows[0]?.erp_id;
    }

    const lines = await tx.query<any>(
      `SELECT l.variant_id, l.quantity FROM order_line l WHERE l.order_id = $1 ORDER BY l.order_line_id`,
      [orderId],
    );
    const erpLines: Array<{ productId: string; quantity: number }> = [];
    for (const line of lines.rows) {
      const mapping = await tx.query<{ erp_id: string }>(
        "SELECT erp_id FROM erp_entity_map WHERE entity_type = 'variant' AND local_id = $1",
        [String(line.variant_id)],
      );
      if (!mapping.rows[0]) {
        throw new ErpError(
          "ERP_CONTRACT_UNSUPPORTED",
          `Variant ${line.variant_id} has no ERP mapping. Run the catalogue sync before pushing orders.`,
        );
      }
      erpLines.push({
        productId: mapping.rows[0].erp_id,
        quantity: line.quantity,
      });
    }

    if (!config.erp.defaultBranchId) {
      throw new ErpError(
        "ERP_CONTRACT_UNSUPPORTED",
        "ERP_DEFAULT_BRANCH_ID is not configured; cannot create an ERP sales order",
      );
    }

    const document = await adapter.createSalesOrderDocument(
      {
        branchId: config.erp.defaultBranchId,
        warehouseId: config.erp.defaultWarehouseId || undefined,
        customerId: erpCustomerId,
        notes: `Web order ${order.order_number}`,
        lines: erpLines,
      },
      syncKey("order-document", orderId),
    );

    let approval: string | null = null;
    if (config.erp.reserveOrders) {
      const approved = await adapter.transitionDocument(
        document.id,
        "approved",
        `Web order ${order.order_number} fulfilment reservation`,
        syncKey("order-document-approve", orderId),
      );
      approval = approved.status;
    }

    await tx.query(
      `INSERT INTO erp_entity_map(entity_type, local_id, erp_id, metadata, last_synced_at)
       VALUES('order',$1,$2,$3,now())
       ON CONFLICT (entity_type, local_id) DO UPDATE SET erp_id = EXCLUDED.erp_id, metadata = EXCLUDED.metadata, last_synced_at = now()`,
      [
        String(orderId),
        document.id,
        JSON.stringify({
          document_status: approval ?? document.status,
          order_number: order.order_number,
          reserved: config.erp.reserveOrders,
        }),
      ],
    );
    await tx.query(
      "UPDATE customer_order SET erp_state = 'synced', updated_at = now() WHERE order_id = $1",
      [orderId],
    );
    await audit(tx, {
      actorType: "system",
      action: "erp.order_pushed",
      entityType: "customer_order",
      entityId: orderId,
      after: {
        erp_document_id: document.id,
        reserved: config.erp.reserveOrders,
      },
    });
    return { erp_document_id: document.id, reserved: config.erp.reserveOrders };
  });
}

export async function pushCustomer(
  db: Database,
  adapter: ErpAdapter,
  customerId: number,
) {
  return db.withTransaction(async (tx) => {
    const customers = await tx.query<any>(
      "SELECT customer_id, email, first_name, last_name, phone FROM customer WHERE customer_id = $1",
      [customerId],
    );
    const customer = customers.rows[0];
    if (!customer) throw new Error(`Customer ${customerId} no longer exists`);

    const existing = await tx.query<{ erp_id: string }>(
      "SELECT erp_id FROM erp_entity_map WHERE entity_type = 'customer' AND local_id = $1",
      [String(customerId)],
    );
    if (existing.rows[0])
      return { skipped: true, erp_id: existing.rows[0].erp_id };

    const code = `WEB-${customerId}`.slice(0, 40);
    const name = `${customer.first_name} ${customer.last_name}`
      .trim()
      .slice(0, 160);
    const matches = await adapter.searchCustomers(customer.email);
    const match =
      matches.find((entry) => entry.code === code) ??
      matches.find((entry) => entry.email === customer.email);
    const erpCustomer =
      match ??
      (await adapter.createCustomer(
        {
          name,
          code,
          email: customer.email,
          phone: customer.phone,
          address: null,
        },
        syncKey("customer", customerId),
      ));

    await tx.query(
      `INSERT INTO erp_entity_map(entity_type, local_id, erp_id, metadata, last_synced_at)
       VALUES('customer',$1,$2,$3,now())
       ON CONFLICT (entity_type, local_id) DO UPDATE SET erp_id = EXCLUDED.erp_id, last_synced_at = now()`,
      [
        String(customerId),
        erpCustomer.id,
        JSON.stringify({ code: erpCustomer.code }),
      ],
    );
    return {
      erp_customer_id: erpCustomer.id,
      matched_existing: Boolean(match),
    };
  });
}

export async function pushPayment(
  db: Database,
  adapter: ErpAdapter,
  input: { orderId: number; paymentId: number },
) {
  return db.withTransaction(async (tx) => {
    const payment = await tx.query<any>(
      `SELECT p.payment_id, p.order_id, p.amount::text AS amount, p.provider_reference, o.customer_id
         FROM payment p JOIN customer_order o ON o.order_id = p.order_id
        WHERE p.payment_id = $1`,
      [input.paymentId],
    );
    const row = payment.rows[0];
    if (!row) throw new Error(`Payment ${input.paymentId} no longer exists`);
    if (!row.customer_id) {
      throw new ErpError(
        "ERP_CONTRACT_UNSUPPORTED",
        "Guest payments cannot be posted through POST /customers/settlements (it requires an ERP customer). " +
          "Requested contract G5 provides POST /integration/payments.",
      );
    }
    const customerMap = await tx.query<{ erp_id: string }>(
      "SELECT erp_id FROM erp_entity_map WHERE entity_type = 'customer' AND local_id = $1",
      [String(row.customer_id)],
    );
    if (!customerMap.rows[0]) {
      throw new ErpError(
        "ERP_CONTRACT_UNSUPPORTED",
        "The customer has no ERP mapping yet. Push the customer first.",
      );
    }
    const methodSetting = await tx.query<{ value: any }>(
      "SELECT value FROM app_setting WHERE key = 'erp'",
    );
    const paymentMethodId = methodSetting.rows[0]?.value?.payment_method_id;
    if (!paymentMethodId) {
      throw new ErpError(
        "ERP_CONTRACT_UNSUPPORTED",
        "No ERP payment method mapping is configured (app_setting erp.payment_method_id). " +
          "Recording money against an invented method is not allowed.",
      );
    }

    const result = await adapter.settleCustomer(
      {
        customerId: customerMap.rows[0].erp_id,
        methodId: String(paymentMethodId),
        amount: toMoney(row.amount),
        reference: row.provider_reference,
      },
      syncKey("payment", row.payment_id),
    );
    await tx.query(
      `INSERT INTO erp_entity_map(entity_type, local_id, erp_id, metadata, last_synced_at)
       VALUES('payment',$1,$2,$3,now())
       ON CONFLICT (entity_type, local_id) DO UPDATE SET erp_id = EXCLUDED.erp_id, last_synced_at = now()`,
      [
        String(row.payment_id),
        result.id ?? result.receipt_id ?? `payment-${row.payment_id}`,
        JSON.stringify({ order_id: row.order_id }),
      ],
    );
    return { erp_reference: result.id ?? result.receipt_id ?? null };
  });
}

export async function pushRefund(
  db: Database,
  adapter: ErpAdapter,
  refundId: string,
) {
  // Explicitly unsupported: refunds by external reference need contract G6.
  await adapter.createRefundByReference();
  throw new Error(
    `unreachable: refund ${refundId} should have raised ERP_CONTRACT_UNSUPPORTED`,
  );
}

// ---------------------------------------------------------------------------
// Worker-facing dispatcher
// ---------------------------------------------------------------------------
export async function executeSyncJob(
  db: Database,
  adapter: ErpAdapter,
  job: any,
): Promise<JobOutcome> {
  try {
    switch (job.operation) {
      case "pull_catalog":
        return { status: "succeeded", summary: await pullCatalog(db, adapter) };
      case "pull_inventory":
        return {
          status: "succeeded",
          summary: await pullInventory(db, adapter),
        };
      case "push_order_document":
        return {
          status: "succeeded",
          summary: await pushOrderDocument(
            db,
            adapter,
            Number(job.payload.orderId ?? job.payload.order_id),
          ),
        };
      case "push_customer":
        return {
          status: "succeeded",
          summary: await pushCustomer(
            db,
            adapter,
            Number(job.payload.customerId),
          ),
        };
      case "push_payment":
        return {
          status: "succeeded",
          summary: await pushPayment(db, adapter, {
            orderId: Number(job.payload.orderId),
            paymentId: Number(job.payload.paymentId),
          }),
        };
      case "push_refund":
        return {
          status: "succeeded",
          summary: await pushRefund(db, adapter, String(job.payload.refundId)),
        };
      default:
        throw new ErpError(
          "ERP_CONTRACT_UNSUPPORTED",
          `Unknown sync operation: ${job.operation}`,
        );
    }
  } catch (error: any) {
    const retryable =
      error instanceof ErpError &&
      (error.retryable ||
        error.code === "ERP_UNAVAILABLE" ||
        error.code === "ERP_RATE_LIMITED");
    logger.warn(
      { jobId: job.job_id, operation: job.operation, err: error?.message },
      "ERP sync job failed",
    );
    return {
      status: retryable ? "retry" : "dead",
      error: String(error?.message ?? error),
      errorCode:
        error instanceof ErpError ? (error.erpCode ?? error.code) : undefined,
    };
  }
}

export async function processSyncJobs(
  db: Database,
  adapter: ErpAdapter,
  max = 10,
) {
  const results: Array<{ job_id: number; operation: string; status: string }> =
    [];
  for (let index = 0; index < max; index++) {
    const job = await claimDueSyncJob(db);
    if (!job) break;
    const logId = await startLog(db, {
      key: job.idempotency_key,
      entityType: job.entity_type,
      direction: job.direction,
      operation: job.operation,
      attempt: job.attempts,
    });
    const outcome = await executeSyncJob(db, adapter, job);
    await completeSyncJob(db, job, outcome, logId);
    results.push({
      job_id: job.job_id,
      operation: job.operation,
      status: outcome.status,
    });
  }
  return results;
}

export async function syncOverview(db: Queryable) {
  const [jobs, logs, settings] = await Promise.all([
    db.query<any>(
      "SELECT status, count(*)::int AS count FROM erp_sync_job GROUP BY status ORDER BY status",
    ),
    db.query<any>(
      `SELECT log_id, entity_type, direction, operation, status, attempts, error_code, error_message, started_at, finished_at
         FROM erp_sync_log ORDER BY log_id DESC LIMIT 25`,
    ),
    db.query<any>(
      "SELECT key, value FROM app_setting WHERE key LIKE 'erp.%' ORDER BY key",
    ),
  ]);
  return {
    enabled: config.erp.enabled,
    jobs: Object.fromEntries(jobs.rows.map((row) => [row.status, row.count])),
    recent_logs: logs.rows,
    settings: Object.fromEntries(
      settings.rows.map((row) => [row.key, row.value]),
    ),
  };
}

export async function enqueuePeriodicPull(db: Database) {
  if (!config.erp.enabled) return [];
  return Promise.all([
    enqueueSyncJob(db, {
      entityType: "product",
      direction: "pull",
      operation: "pull_catalog",
      localId: `catalog-${Math.floor(Date.now() / config.erp.syncIntervalMs)}`,
      idempotencyKey: `ecommerce:pull-catalog:${Math.floor(Date.now() / config.erp.syncIntervalMs)}`,
      payload: {},
      maxAttempts: 3,
    }),
    enqueueSyncJob(db, {
      entityType: "inventory",
      direction: "pull",
      operation: "pull_inventory",
      localId: `inventory-${Math.floor(Date.now() / config.erp.syncIntervalMs)}`,
      idempotencyKey: `ecommerce:pull-inventory:${Math.floor(Date.now() / config.erp.syncIntervalMs)}`,
      payload: {},
      maxAttempts: 3,
    }),
  ]);
}
