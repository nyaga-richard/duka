/**
 * Background worker: reservation expiry, ERP sync retries and periodic pulls.
 *
 * Safe to run more than one replica: reservation sweeps use
 * `FOR UPDATE SKIP LOCKED`, sync jobs are claimed atomically, and the heartbeat
 * is keyed by worker name.
 */
import { config } from "./config.ts";
import { logger } from "./logger.ts";
import { closeDatabase, getDatabase } from "./db/index.ts";
import { expireStaleReservations } from "./services/reservations.ts";
import { enqueuePeriodicPull, processSyncJobs } from "./services/sync.ts";
import { getErpAdapter, erpEnabled } from "./integrations/erp.ts";

const WORKER_NAME = process.env.WORKER_NAME ?? "ecommerce-worker";

export interface TickResult {
  expired_reservations: number;
  sync_jobs: Array<{ job_id: number; operation: string; status: string }>;
  erp_enabled: boolean;
}

export async function runWorkerTick(): Promise<TickResult> {
  const db = await getDatabase();
  const expired = await db.withTransaction((tx) =>
    expireStaleReservations(tx, 200),
  );

  let syncJobs: TickResult["sync_jobs"] = [];
  if (erpEnabled()) {
    await enqueuePeriodicPull(db).catch((error) =>
      logger.warn(
        { err: error?.message },
        "could not enqueue periodic ERP pull",
      ),
    );
    syncJobs = await processSyncJobs(db, getErpAdapter(), 5);
  }

  await db.query(
    `INSERT INTO worker_heartbeat(worker_name, last_seen_at, detail) VALUES($1, now(), $2)
     ON CONFLICT (worker_name) DO UPDATE SET last_seen_at = now(), detail = EXCLUDED.detail`,
    [
      WORKER_NAME,
      JSON.stringify({
        expired_reservations: expired.expired,
        sync_jobs: syncJobs.length,
      }),
    ],
  );

  return {
    expired_reservations: expired.expired,
    sync_jobs: syncJobs,
    erp_enabled: erpEnabled(),
  };
}

async function main() {
  const intervalMs = Math.max(
    Number(process.env.WORKER_INTERVAL_MS ?? 5000),
    1000,
  );
  logger.info(
    { worker: WORKER_NAME, interval_ms: intervalMs, erp_enabled: erpEnabled() },
    "worker starting",
  );
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker stopping");
    await closeDatabase().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  while (!stopping) {
    try {
      const result = await runWorkerTick();
      if (result.expired_reservations || result.sync_jobs.length) {
        logger.info(result, "worker tick");
      }
    } catch (error: any) {
      logger.error(
        { err: error?.message, stack: error?.stack },
        "worker tick failed",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (process.env.WORKER_EMBEDDED !== "true") {
  await main();
}
