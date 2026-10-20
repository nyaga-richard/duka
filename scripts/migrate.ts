import "dotenv/config";
import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export async function migrate(url = process.env.DATABASE_URL) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(73408219)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir("database/migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(`database/migrations/${name}`, "utf8"),
        checksum = createHash("sha256").update(sql).digest("hex");
      const r = await client.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (r.rowCount) {
        if (r.rows[0].checksum !== checksum)
          throw new Error(`Migration changed after application: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
          [name, checksum],
        );
        await client.query("COMMIT");
        console.log(`Applied ${name}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    for (const [key, write] of [
      ["RUNTIME_DB_ROLE", true],
      ["BACKUP_DB_ROLE", false],
    ] as const) {
      const role = process.env[key];
      if (!role) continue;
      if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(role))
        throw new Error("Invalid operational role name");
      const quoted = '"' + role + '"';
      await client.query(`GRANT USAGE ON SCHEMA public TO ${quoted}`);
      await client.query(
        `GRANT ${write ? "SELECT,INSERT,UPDATE,DELETE" : "SELECT"} ON ALL TABLES IN SCHEMA public TO ${quoted}`,
      );
      if (write) {
        await client.query(
          `REVOKE INSERT,UPDATE,DELETE ON schema_migrations FROM ${quoted}`,
        );
        await client.query(
          `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoted}`,
        );
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(73408219)");
    await client.end();
  }
}
if (/\/migrate\.(ts|mjs)$/.test(process.argv[1] ?? ""))
  migrate().catch((e) => {
    console.error(
      e instanceof Error
        ? e.message
        : "Migration failed; inspect protected server diagnostics",
    );
    process.exitCode = 1;
  });
