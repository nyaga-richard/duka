/** API process bootstrap. */
import "dotenv/config";
import { config, describeConfig } from "./config.ts";
import { logger } from "./logger.ts";
import { closeDatabase, getDatabase } from "./db/index.ts";
import { migrate, migrationsCurrent } from "./db/migrate.ts";
import { createApp } from "./app.ts";

const db = await getDatabase();

if (process.env.AUTO_MIGRATE === "true") {
  const result = await migrate(db, {
    log: (line) => logger.info({ migration: line }, "migration"),
  });
  logger.info({ applied: result.applied.length }, "migrations applied at boot");
}

if (!(await migrationsCurrent(db))) {
  logger.error(
    "Database migrations are not current. Run `npm run db:migrate` before starting the API.",
  );
  if (config.isProduction) process.exit(1);
}

const app = createApp({ db });
const server = app.listen(config.port, "0.0.0.0", () => {
  logger.info(
    { ...describeConfig(), port: config.port },
    "ecommerce-api listening",
  );
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await closeDatabase().catch(() => undefined);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
