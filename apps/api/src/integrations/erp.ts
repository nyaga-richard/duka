/**
 * Composition root for the ERP adapter.
 *
 * Configuration comes only from the environment. When ERP_ENABLED is false the
 * adapter is absent and every sync endpoint reports `disabled` rather than
 * pretending to sync.
 */
import { ErpAdapter, HttpErpTransport } from "@ecom/erp-adapter";
import { config } from "../config.ts";
import { logger } from "../logger.ts";
import { fail } from "../errors.ts";

let adapter: ErpAdapter | null = null;

export function getErpAdapter(): ErpAdapter {
  if (!config.erp.enabled) {
    fail(
      503,
      "ERP_UNAVAILABLE",
      "ERP integration is disabled. Set ERP_ENABLED=true with ERP_BASE_URL and a dedicated integration identity.",
    );
  }
  if (!adapter) {
    const transport = new HttpErpTransport({
      baseUrl: config.erp.baseUrl,
      email: config.erp.email,
      password: config.erp.password,
      totpSecret: config.erp.totpSecret || undefined,
      origin: config.erp.allowedOrigin || new URL(config.erp.baseUrl).origin,
      timeoutMs: config.erp.timeoutMs,
      maxAttempts: config.erp.maxAttempts,
      logger: {
        warn: (obj, msg) => logger.warn(obj, msg),
        info: (obj, msg) => logger.info(obj, msg),
      },
    });
    adapter = new ErpAdapter(transport, {
      defaultBranchId: config.erp.defaultBranchId || undefined,
      defaultWarehouseId: config.erp.defaultWarehouseId || undefined,
      reserveOrdersInErp: config.erp.reserveOrders,
    });
  }
  return adapter;
}

export function erpEnabled(): boolean {
  return config.erp.enabled;
}

/** Test seam: inject a fake-backed adapter without touching module state graph. */
export function setErpAdapterForTest(next: ErpAdapter | null) {
  if (config.env === "production")
    throw new Error("Test seam is unavailable in production");
  adapter = next;
}
