import "dotenv/config";
import pg from "pg";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  run,
  pgConnection,
  passphrase,
  decryptArchive,
  extractArchive,
  verifyExtracted,
  fingerprints,
} from "./backup-lib.ts";
export async function testRestore(backup: string) {
  process.umask(0o077);
  if (!backup) throw new Error("Usage: restore-test <encrypted-backup-file>");
  const adminUrl = process.env.RESTORE_ADMIN_DATABASE_URL;
  if (!adminUrl)
    throw new Error(
      "RESTORE_ADMIN_DATABASE_URL must identify a maintenance database and a role allowed to create temporary databases",
    );
  const adminName = decodeURIComponent(new URL(adminUrl).pathname.slice(1));
  if (!["postgres", "template1"].includes(adminName))
    throw new Error(
      "Use postgres or template1 as the restore-test maintenance database; existing business databases are never targets",
    );
  const stage = await mkdtemp(path.join(tmpdir(), "duka-restore-")),
    admin = new pg.Client({ connectionString: adminUrl });
  let created = false;
  let restored: pg.Client | undefined;
  let result: any;
  const name =
    "duka_restore_" +
    Date.now() +
    "_" +
    randomUUID().replaceAll("-", "").slice(0, 12);
  try {
    // Authenticate the whole archive before extracting anything or creating a DB.
    const archive = path.join(stage, "authenticated.tar");
    await decryptArchive(path.resolve(backup), archive, await passphrase());
    const extracted = path.join(stage, "verified");
    await extractArchive(archive, extracted);
    const manifest = await verifyExtracted(extracted);
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    const target = new URL(adminUrl);
    target.pathname = "/" + name;
    const connection = pgConnection(target.toString());
    await run(
      "pg_restore",
      [
        ...connection.args,
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--single-transaction",
        path.join(extracted, "database.dump"),
      ],
      connection.env,
    );
    restored = new pg.Client({ connectionString: target.toString() });
    await restored.connect();
    const identity = (await restored.query("SELECT current_database() AS name"))
      .rows[0];
    assert.equal(identity.name, name);
    // A database-owner restore connection is privileged only in this disposable DB.
    // FORCE RLS still applies, so fingerprint individual tenant tables per tenant
    // through a temporary SECURITY DEFINER-free owner session with RLS bypass when
    // the maintenance role has it; otherwise use a transaction-scoped table policy
    // inspection under the original data's tenant settings (below).
    const role = (
      await restored.query(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    if (!role.rolsuper && !role.rolbypassrls) {
      // Only these freshly-created clone tables: temporarily disable FORCE RLS for
      // the owner while fingerprinting. Re-enable it before domain verification.
      const forced = (
        await restored.query(
          "SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relforcerowsecurity ORDER BY relname",
        )
      ).rows;
      await restored.query("BEGIN");
      try {
        for (const { relname } of forced)
          await restored.query(
            'ALTER TABLE "' +
              relname.replaceAll('"', '""') +
              '" NO FORCE ROW LEVEL SECURITY',
          );
        assert.deepEqual(await fingerprints(restored), manifest.fingerprints);
        await restored.query("ROLLBACK");
      } catch (e) {
        await restored.query("ROLLBACK");
        throw e;
      }
    } else
      assert.deepEqual(await fingerprints(restored), manifest.fingerprints);
    await restored.end();
    restored = undefined;
    const bundled = import.meta.url.endsWith(".mjs"),
      script = fileURLToPath(
        new URL(
          bundled ? "./reconcile.mjs" : "./reconcile.ts",
          import.meta.url,
        ),
      );
    const text = await run(
      process.execPath,
      [...(!bundled ? ["--import", "tsx"] : []), script],
      {
        ...process.env,
        DATABASE_URL: target.toString(),
        RECONCILE_COMPANY_ID: "",
      },
    );
    const integrity = JSON.parse(text);
    assert.equal(
      integrity.matches,
      true,
      "Restored financial reconciliation must pass",
    );
    result = {
      verified: true,
      verified_at: new Date().toISOString(),
      backup_created_at: manifest.created_at,
      temporary_database: name,
      tables: Object.keys(manifest.fingerprints).length,
      attachments: manifest.attachments.length,
      companies: integrity.companies.length,
      row_fingerprints_match: true,
      attachment_hashes_match: true,
      subledgers_and_inventory_match: true,
      temporary_database_removed: false,
    };
  } finally {
    if (restored) await restored.end().catch(() => {});
    try {
      if (created) {
        if (!/^duka_restore_\d+_[0-9a-f]{12}$/.test(name))
          throw new Error("Refusing unsafe cleanup name");
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        if (result) result.temporary_database_removed = true;
      }
    } finally {
      await admin.end().catch(() => {});
      await rm(stage, { recursive: true, force: true });
    }
  }
  if (process.env.RESTORE_REPORT_FILE)
    await writeFile(
      process.env.RESTORE_REPORT_FILE,
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
  return result;
}
if (/\/restore-test\.(ts|mjs)$/.test(process.argv[1] ?? ""))
  try {
    console.log(JSON.stringify(await testRestore(process.argv[2]), null, 2));
  } catch (e: any) {
    console.error(e.message);
    process.exitCode = 1;
  }
