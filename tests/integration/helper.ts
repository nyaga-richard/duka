import "dotenv/config";
import { migrate } from "../../scripts/migrate.ts";
if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error(
    "Destructive tests require TEST_DATABASE_URL ending in _test",
  );
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.MPESA_MODE = "mock";
process.env.UPLOAD_DIR = new URL(
  "../../artifacts/test-uploads",
  import.meta.url,
).pathname;
process.env.ETIMS_MODE = "disabled";
const { pool } = await import("../../apps/api/src/db.ts");
if (pool.options.connectionString !== process.env.TEST_DATABASE_URL)
  throw new Error(
    "Refusing tests: application pool was initialized against a different database. Use npm test (the guarded test-env preload).",
  );
const actual = (await pool.query("SELECT current_database() AS name")).rows[0]
  .name;
if (
  actual !==
  decodeURIComponent(new URL(process.env.TEST_DATABASE_URL).pathname.slice(1))
)
  throw new Error(
    "Refusing tests: server selected a different physical database",
  );
await migrate(process.env.TEST_DATABASE_URL);
export async function fixture() {
  const { createCompany } = await import("../../scripts/setup.ts");
  const { randomUUID } = await import("node:crypto");
  return createCompany({
    name: "Integration business",
    email: `test-${randomUUID()}@example.test`,
    password: "TestSecurePass-2026",
  });
}
