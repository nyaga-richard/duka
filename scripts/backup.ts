import "dotenv/config";
import pg from "pg";
import path from "node:path";
import {
  mkdtemp,
  chmod,
  open,
  mkdir,
  writeFile,
  copyFile,
  lstat,
  realpath,
  rm,
  rename,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  run,
  pgConnection,
  sha256,
  passphrase,
  encryptArchive,
  fingerprints,
  type BackupManifest,
} from "./backup-lib.ts";
export async function createBackup() {
  process.umask(0o077);
  const url = process.env.BACKUP_DATABASE_URL;
  if (!url)
    throw new Error(
      "Set BACKUP_DATABASE_URL for a read-only RLS-bypass backup role, never the API role",
    );
  const secret = await passphrase(),
    root = path.resolve(process.env.BACKUP_DIR ?? "backups");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const stage = await mkdtemp(path.join(root, ".staging-")),
    db = new pg.Client({ connectionString: url });
  let partial = "";
  try {
    await db.connect();
    const role = (
      await db.query(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    if (!role.rolsuper && !role.rolbypassrls)
      throw new Error(
        "A full tenant backup requires an explicitly authorized RLS-bypass read role",
      );
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SET row_security=off");
    const info = (
      await db.query(
        "SELECT current_database() AS name,current_setting('server_version') AS version,clock_timestamp() AS created_at,pg_export_snapshot() AS snapshot",
      )
    ).rows[0];
    const refs = (
      await db.query(
        "SELECT storage_key,size FROM attachments ORDER BY storage_key",
      )
    ).rows;
    const data = await fingerprints(db);
    const connection = pgConnection(url);
    await run(
      "pg_dump",
      [
        ...connection.args,
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--snapshot=" + info.snapshot,
        "--file=" + path.join(stage, "database.dump"),
      ],
      connection.env,
    );
    const uploads = path.resolve(process.env.UPLOAD_DIR ?? "uploads");
    await mkdir(path.join(stage, "uploads"), { mode: 0o700 });
    const files: BackupManifest["attachments"] = [];
    for (const ref of refs) {
      if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(ref.storage_key))
        throw new Error("Refusing an unsafe attachment storage key");
      const source = path.join(uploads, ref.storage_key),
        sourceStat = await lstat(source);
      if (
        !sourceStat.isFile() ||
        sourceStat.isSymbolicLink() ||
        !(await realpath(source)).startsWith(
          (await realpath(uploads)) + path.sep,
        ) ||
        sourceStat.size !== ref.size
      )
        throw new Error(
          "An attachment is missing, unsafe or has the wrong size",
        );
      const target = path.join(stage, "uploads", ref.storage_key);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      files.push({ ...ref, sha256: await sha256(target) });
    }
    await db.query("COMMIT");
    const manifest: BackupManifest = {
      format: 1,
      created_at: new Date(info.created_at).toISOString(),
      postgres_version: info.version,
      source_database: info.name,
      fingerprints: data,
      dump_sha256: await sha256(path.join(stage, "database.dump")),
      attachments: files,
    };
    await writeFile(
      path.join(stage, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    const archive = path.join(stage, "payload.tar");
    await run("tar", [
      "-C",
      stage,
      "-cf",
      archive,
      "database.dump",
      "manifest.json",
      "uploads",
    ]);
    const destination = path.join(
      root,
      `duka-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}.enc`,
    );
    partial = destination + ".partial";
    await encryptArchive(archive, partial, secret);
    await rename(partial, destination);
    partial = "";
    await writeFile(
      destination + ".sha256",
      `${await sha256(destination)}  ${path.basename(destination)}\n`,
      { mode: 0o600 },
    );
    const directory = await open(root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return {
      file: destination,
      created_at: manifest.created_at,
      tables: Object.keys(data).length,
      attachments: files.length,
      encryption: "AES-256-GCM + scrypt",
      snapshot_consistent: true,
    };
  } finally {
    await db.end().catch(() => {});
    await rm(stage, { recursive: true, force: true });
    if (partial) await rm(partial, { force: true });
  }
}
if (/\/backup\.(ts|mjs)$/.test(process.argv[1] ?? ""))
  try {
    console.log(JSON.stringify(await createBackup(), null, 2));
  } catch (e: any) {
    console.error(e.message);
    process.exitCode = 1;
  }
