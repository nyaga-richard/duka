import { processMailJob } from "../services/auth.ts";
import { pool } from "../db.ts";
import { processMpesaEvent } from "./mpesa.ts";
import { processFiscalJob } from "./fiscal.ts";
async function claim(table: "provider_events" | "fiscal_dispatch") {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const row = (
      await db.query(
        `SELECT id FROM ${table} WHERE status IN ('received','pending','processing') AND next_attempt_at<=now() AND attempts<10 ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      )
    ).rows[0];
    if (row)
      await db.query(
        `UPDATE ${table} SET status='processing',attempts=attempts+1,next_attempt_at=now()+interval '2 minutes' WHERE id=$1`,
        [row.id],
      );
    await db.query("COMMIT");
    return row?.id;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
let busy = false;
export async function runJobsOnce() {
  if (busy) return;
  busy = true;
  try {
    await pool.query(
      "UPDATE mail_outbox SET status='expired',body='',lease_token=NULL WHERE expires_at<=now() AND status IN ('pending','processing','failed')",
    );
    if (process.env.MAIL_MODE === "smtp") {
      const mail = (
        await pool.query(
          "SELECT id FROM mail_outbox WHERE delivery_mode='smtp' AND status IN ('pending','processing') AND next_attempt_at<=now() AND expires_at>now() AND attempts<10 ORDER BY next_attempt_at LIMIT 1",
        )
      ).rows[0];
      if (mail) await processMailJob(mail.id);
    }
    for (const table of ["provider_events", "fiscal_dispatch"] as const) {
      const id = await claim(table);
      if (!id) continue;
      try {
        if (table === "provider_events") await processMpesaEvent(id);
        else await processFiscalJob(id);
      } catch (e: any) {
        await pool.query(
          `UPDATE ${table} SET status=CASE WHEN attempts>=10 THEN 'failed' ELSE 'pending' END,last_error=$1,next_attempt_at=now()+make_interval(secs=>least(3600,30*power(2,attempts)::int)) WHERE id=$2`,
          [String(e.message).slice(0, 1000), id],
        );
      }
    }
  } finally {
    busy = false;
  }
}
export function startWorker() {
  const timer = setInterval(
    () =>
      runJobsOnce().catch((e) =>
        console.error("integration worker", e.message),
      ),
    3000,
  );
  timer.unref();
  return () => clearInterval(timer);
}
