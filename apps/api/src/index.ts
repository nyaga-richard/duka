import "dotenv/config";
import { createApp, log } from "./app.ts";
import { pool } from "./db.ts";
import { assertDatabaseReady } from "./readiness.ts";
import { startWorker } from "./integrations/worker.ts";
if (
  process.env.WORKSPACE_PREVIEW === "true" &&
  (process.env.NODE_ENV === "production" || process.env.DEMO_MODE !== "true")
)
  throw new Error(
    "Workspace preview authentication is allowed only in an explicitly isolated development demo, never production",
  );
if (
  process.env.WORKSPACE_PREVIEW === "true" &&
  (!["mock", "disabled"].includes(process.env.MPESA_MODE ?? "disabled") ||
    (process.env.ETIMS_MODE ?? "disabled") !== "disabled")
)
  throw new Error(
    "Workspace preview authentication forbids live payment and fiscal integrations",
  );
if (process.env.NODE_ENV === "production") {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error(
      "Disabling TLS certificate verification is forbidden in production",
    );
  for (const name of [
    "DATABASE_URL",
    "WEB_ORIGIN",
    "ALLOWED_ORIGINS",
    "MFA_ENCRYPTION_KEY",
  ])
    if (!process.env[name]) throw new Error(`Production requires ${name}`);
  if (
    process.env.COOKIE_SECURE !== "true" ||
    !process.env.WEB_ORIGIN?.startsWith("https://")
  )
    throw new Error("Production requires HTTPS and secure cookies");
  if (process.env.DEMO_MODE === "true" || process.env.MPESA_MODE === "mock")
    throw new Error("Demo and mock payments are forbidden in production");
  if (
    !process.env.ALLOWED_ORIGINS!.split(",").every((o) => {
      try {
        return (
          new URL(o.trim()).protocol === "https:" &&
          new URL(o.trim()).origin === o.trim()
        );
      } catch {
        return false;
      }
    }) ||
    !process.env
      .ALLOWED_ORIGINS!.split(",")
      .map((s) => s.trim())
      .includes(process.env.WEB_ORIGIN!)
  )
    throw new Error(
      "Allowed origins must be exact HTTPS origins and include WEB_ORIGIN",
    );
  const mfaKey = process.env.MFA_ENCRYPTION_KEY!;
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(mfaKey) ||
    Buffer.from(mfaKey, "base64").length !== 32
  )
    throw new Error("MFA_ENCRYPTION_KEY must be a random 32-byte base64 value");
  if (!["disabled", "daraja"].includes(process.env.MPESA_MODE ?? "disabled"))
    throw new Error("Invalid production MPESA_MODE");
  if (!["disabled", "adapter"].includes(process.env.ETIMS_MODE ?? "disabled"))
    throw new Error("Invalid ETIMS_MODE");
  if (
    process.env.MPESA_MODE === "daraja" &&
    [
      "MPESA_CONSUMER_KEY",
      "MPESA_CONSUMER_SECRET",
      "MPESA_SHORTCODE",
      "MPESA_PASSKEY",
      "MPESA_CALLBACK_SECRET",
      "MPESA_CALLBACK_BASE_URL",
    ].some((n) => !process.env[n])
  )
    throw new Error(
      "Daraja requires complete credentials and callback configuration",
    );
  if (
    process.env.MPESA_MODE === "daraja" &&
    (!process.env.MPESA_CALLBACK_BASE_URL!.startsWith("https://") ||
      process.env.MPESA_CALLBACK_SECRET!.length < 32)
  )
    throw new Error(
      "Daraja callback requires HTTPS and a strong callback secret",
    );
  if (
    process.env.ETIMS_MODE === "adapter" &&
    (!process.env.ETIMS_ADAPTER_URL?.startsWith("https://") ||
      !process.env.ETIMS_ADAPTER_TOKEN)
  )
    throw new Error(
      "Fiscal adapter requires an approved HTTPS gateway and credentials",
    );
  if (process.env.MAIL_MODE !== "smtp" || !process.env.SMTP_URL)
    throw new Error("Configure SMTP for safe password reset delivery");
  let smtpProtocol = "";
  try {
    smtpProtocol = new URL(process.env.SMTP_URL).protocol;
  } catch {
    throw new Error(
      "SMTP_URL must be a valid SMTP/SMTPS URL; the value is not logged",
    );
  }
  if (!["smtp:", "smtps:"].includes(smtpProtocol))
    throw new Error(
      "SMTP_URL must use smtp or smtps; production SMTP requires verified TLS",
    );
  if (
    process.env.MPESA_MODE === "daraja" &&
    !/^https:\/\/api\.safaricom\.co\.ke\/?$/.test(
      process.env.MPESA_BASE_URL ?? "",
    )
  )
    throw new Error(
      "Production financial posting requires the official live Daraja base URL, never sandbox",
    );
}
await assertDatabaseReady();
const app = createApp();
const server = app.listen(Number(process.env.PORT ?? 4000), "0.0.0.0", () =>
  log.info({ port: process.env.PORT ?? 4000 }, "Duka API ready"),
);
server.requestTimeout = 30000;
server.headersTimeout = 35000;
const stopWorker = startWorker();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  stopWorker();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
