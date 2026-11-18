/**
 * Phase 1 seed.
 *
 * Deliberately boring: no sample customers, products or orders. Reference data
 * (permissions, roles, order statuses, shipping methods, countries) is created
 * by migrations, which are the single source of truth. This script only:
 *   - provisions the first administrator when both bootstrap env vars are set;
 *   - records non-secret store settings;
 *   - prints a secret-free summary.
 *
 * Run: npm run db:seed
 */
import "dotenv/config";
import { getDatabase, closeDatabase } from "../../apps/api/src/db/index.ts";
import { migrate, migrationStatus } from "../../apps/api/src/db/migrate.ts";
import { provisionAdmin } from "../../apps/api/src/services/auth.ts";
import { config, describeConfig } from "../../apps/api/src/config.ts";

async function main() {
  const db = await getDatabase();
  await migrate(db);
  const status = await migrationStatus(db);
  if (status.some((entry) => !entry.applied || !entry.checksum_matches)) {
    throw new Error(
      "Migrations are not current; refusing to seed a half-migrated database",
    );
  }

  const settings: Array<[string, string]> = [
    ["store.name", "Duka"],
    ["store.currency", "KES"],
    ["store.country", "Kenya"],
    ["store.timezone", "Africa/Nairobi"],
    ["catalog.price_source", "erp"],
    ["catalog.stock_source", "erp"],
  ];
  for (const [key, value] of settings) {
    await db.query(
      `INSERT INTO app_setting(key, value) VALUES($1,$2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  let admin: { created: boolean; email: string } | null = null;
  if (config.adminBootstrap.email || config.adminBootstrap.password) {
    if (!config.adminBootstrap.email || !config.adminBootstrap.password) {
      throw new Error(
        "Set both ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD, or neither",
      );
    }
    if (config.adminBootstrap.password.length < 12) {
      throw new Error(
        "ADMIN_BOOTSTRAP_PASSWORD must be at least 12 characters",
      );
    }
    const result = await provisionAdmin(db, {
      email: config.adminBootstrap.email,
      password: config.adminBootstrap.password,
      displayName: "Store Owner",
      role: "owner",
    });
    admin = { created: result.created, email: config.adminBootstrap.email };
  }

  const counts = await db.query<{
    products: number;
    customers: number;
    orders: number;
  }>(
    `SELECT (SELECT count(*) FROM product)::int AS products,
            (SELECT count(*) FROM customer)::int AS customers,
            (SELECT count(*) FROM customer_order)::int AS orders`,
  );

  console.log(
    JSON.stringify(
      {
        seeded: true,
        settings: settings.length,
        admin,
        data: counts.rows[0],
        config: describeConfig(),
      },
      null,
      2,
    ),
  );

  if (!config.erp.enabled) {
    console.log(
      "ERP integration is disabled: the catalogue stays empty until you enable it and run a catalogue pull.",
    );
  }
  if (!admin) {
    console.log(
      "No administrator was created. Set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD to create one.",
    );
  }
  await closeDatabase();
}

main().catch(async (error) => {
  console.error("seed failed:", error instanceof Error ? error.message : error);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
