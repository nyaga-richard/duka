/**
 * Forward-only, checksummed SQL migration runner.
 *
 * - one advisory lock so two deploys cannot migrate at once;
 * - every file is applied in its own transaction;
 * - checksums are recorded and an edited, already-applied file is a hard error;
 * - re-running is a no-op (verified by tests).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.ts";
import type { Database } from "./index.ts";

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  applied_at: string;
  duration_ms: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function resolveMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const candidates = [
    path.resolve(here, "../../../../database/migrations"),
    path.resolve(process.cwd(), "database/migrations"),
    path.resolve(here, "../../database/migrations"),
  ];
  // Prefer a directory that actually exists: a bundled build runs from `dist/`.
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}

async function ensureMigrationTable(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version varchar(20) PRIMARY KEY,
      name varchar(200) NOT NULL,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      duration_ms int NOT NULL DEFAULT 0
    );
  `);
}

export async function listMigrations(dir = resolveMigrationsDir()) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (file) => {
      const fullPath = path.join(dir, file);
      const sql = await readFile(fullPath, "utf8");
      const version = file.split("_")[0]!;
      return {
        file,
        fullPath,
        version,
        name: file.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

export async function appliedMigrations(
  db: Database,
): Promise<AppliedMigration[]> {
  await ensureMigrationTable(db);
  const result = await db.query<AppliedMigration>(
    "SELECT version, name, checksum, applied_at::text, duration_ms FROM schema_migrations ORDER BY version",
  );
  return result.rows;
}

export async function migrate(
  db: Database,
  options: { dir?: string; log?: (line: string) => void } = {},
): Promise<{ applied: string[]; alreadyApplied: number }> {
  const log = options.log ?? (() => undefined);
  const dir = options.dir ?? resolveMigrationsDir();
  await ensureMigrationTable(db);

  let locked = false;
  try {
    await db.query("SELECT pg_advisory_lock($1)", [config.db.migrationLockId]);
    locked = true;
  } catch {
    log(
      "advisory lock unavailable on this driver; continuing single-connection",
    );
  }

  try {
    const files = await listMigrations(dir);
    const done = new Map(
      (await appliedMigrations(db)).map((m) => [m.version, m]),
    );
    const applied: string[] = [];

    for (const migration of files) {
      const previous = done.get(migration.version);
      if (previous) {
        if (previous.checksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.file} changed after it was applied (checksum mismatch). ` +
              "Migrations are forward-only: restore the original file and add a new migration instead.",
          );
        }
        continue;
      }
      const started = Date.now();
      log(`applying ${migration.file}`);
      await db.withTransaction(async (tx) => {
        await tx.exec(migration.sql);
        await tx.query(
          "INSERT INTO schema_migrations(version,name,checksum,duration_ms) VALUES($1,$2,$3,$4)",
          [
            migration.version,
            migration.name,
            migration.checksum,
            Date.now() - started,
          ],
        );
      });
      applied.push(migration.name);
    }
    return { applied, alreadyApplied: files.length - applied.length };
  } finally {
    if (locked)
      await db
        .query("SELECT pg_advisory_unlock($1)", [config.db.migrationLockId])
        .catch(() => undefined);
  }
}

export async function migrationStatus(db: Database, dir?: string) {
  const files = await listMigrations(dir);
  const appliedRows = await appliedMigrations(db);
  const applied = new Map(appliedRows.map((m) => [m.version, m]));
  return files.map((f) => ({
    version: f.version,
    name: f.name,
    applied: applied.has(f.version),
    checksum_matches: applied.has(f.version)
      ? applied.get(f.version)!.checksum === f.checksum
      : null,
    applied_at: applied.get(f.version)?.applied_at ?? null,
  }));
}

/** Every migration applied and no checksum drift — used by /health/ready. */
export async function migrationsCurrent(
  db: Database,
  dir?: string,
): Promise<boolean> {
  try {
    const statuses = await migrationStatus(db, dir);
    return statuses.every((s) => s.applied && s.checksum_matches !== false);
  } catch {
    return false;
  }
}
