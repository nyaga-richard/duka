import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  readFile,
  writeFile,
  appendFile,
  open,
  stat,
  mkdir,
} from "node:fs/promises";
import {
  createHash,
  randomBytes,
  scrypt,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
export const magic = Buffer.from("DUKABK01");
export function pgConnection(url: string) {
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol))
    throw new Error("Expected a PostgreSQL connection URL");
  const password =
    parsed.searchParams.get("password") ?? decodeURIComponent(parsed.password);
  parsed.password = "";
  parsed.searchParams.delete("password");
  return {
    args: ["--dbname=" + parsed.toString()],
    env: {
      ...process.env,
      PGPASSWORD: password || process.env.PGPASSWORD || "",
      PGCONNECT_TIMEOUT: "10",
    },
  };
}
export function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${command} failed (${code}): ${err.slice(-1500)}`)),
    );
  });
}
export async function sha256(file: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
export async function passphrase() {
  const file = process.env.BACKUP_PASSPHRASE_FILE;
  if (!file)
    throw new Error(
      "Set BACKUP_PASSPHRASE_FILE to a separately protected secret file",
    );
  if ((await stat(file)).mode & 0o077)
    throw new Error("Backup passphrase file must have mode 0600 or 0400");
  const value = (await readFile(file, "utf8")).trim();
  if (value.length < 32)
    throw new Error("Use a random backup passphrase of at least 32 characters");
  return value;
}
function derive(pass: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(
      pass,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 },
      (e, key) => (e ? reject(e) : resolve(key)),
    ),
  );
}
export async function encryptArchive(
  archive: string,
  destination: string,
  pass: string,
) {
  const salt = randomBytes(16),
    iv = randomBytes(12),
    header = Buffer.concat([magic, salt, iv]);
  const cipher = createCipheriv("aes-256-gcm", await derive(pass, salt), iv);
  cipher.setAAD(header);
  await writeFile(destination, header, { mode: 0o600, flag: "wx" });
  await pipeline(
    createReadStream(archive),
    cipher,
    createWriteStream(destination, { flags: "a", mode: 0o600 }),
  );
  await appendFile(destination, cipher.getAuthTag());
  const f = await open(destination, "r+");
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
export async function decryptArchive(
  source: string,
  destination: string,
  pass: string,
) {
  const file = await open(source, "r");
  let header = Buffer.alloc(36),
    tag = Buffer.alloc(16);
  let length: number;
  try {
    length = (await file.stat()).size;
    if (length < 53) throw new Error("Backup is truncated");
    await file.read(header, 0, 36, 0);
    await file.read(tag, 0, 16, length - 16);
  } finally {
    await file.close();
  }
  if (!header.subarray(0, 8).equals(magic))
    throw new Error("Unsupported backup format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    await derive(pass, header.subarray(8, 24)),
    header.subarray(24, 36),
  );
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  await pipeline(
    createReadStream(source, { start: 36, end: length! - 17 }),
    decipher,
    createWriteStream(destination, { mode: 0o600, flags: "wx" }),
  );
}
export async function fingerprints(db: pg.Client) {
  await db.query("SET TIME ZONE 'UTC'");
  await db.query("SET bytea_output='hex'");
  const tables = (
    await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const result: Record<
    string,
    { rows: string; hash_a: string; hash_b: string }
  > = {};
  for (const { tablename } of tables) {
    const identifier = '"' + tablename.replaceAll('"', '""') + '"';
    result[tablename] = (
      await db.query(
        `SELECT count(*)::text AS rows,coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),1,15))::bit(60)::bigint),0)::text AS hash_a,coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),17,15))::bit(60)::bigint),0)::text AS hash_b FROM public.${identifier} t`,
      )
    ).rows[0];
  }
  return result;
}
export async function extractArchive(archive: string, destination: string) {
  const entries = (await run("tar", ["-tf", archive])).trim().split("\n");
  const allowed =
    /^(database\.dump|manifest\.json|uploads\/?|uploads\/[0-9a-f-]{36}\/?|uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36})$/i;
  if (
    entries.some((p) => !allowed.test(p)) ||
    !entries.includes("database.dump") ||
    !entries.includes("manifest.json")
  )
    throw new Error("Unsafe or incomplete backup archive paths");
  const listing = (await run("tar", ["-tvf", archive])).trim().split("\n");
  if (listing.some((line) => !["-", "d"].includes(line[0])))
    throw new Error("Backup must not contain links or special files");
  await mkdir(destination, { mode: 0o700 });
  await run("tar", [
    "--no-same-owner",
    "--no-same-permissions",
    "--keep-old-files",
    "-xf",
    archive,
    "-C",
    destination,
  ]);
}
export interface BackupManifest {
  format: 1;
  created_at: string;
  postgres_version: string;
  source_database: string;
  fingerprints: Awaited<ReturnType<typeof fingerprints>>;
  dump_sha256: string;
  attachments: { storage_key: string; size: number; sha256: string }[];
}
export async function verifyExtracted(directory: string) {
  const path = await import("node:path");
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  ) as BackupManifest;
  if (
    manifest.format !== 1 ||
    !Array.isArray(manifest.attachments) ||
    !manifest.fingerprints
  )
    throw new Error("Invalid backup manifest");
  if (
    (await sha256(path.join(directory, "database.dump"))) !==
    manifest.dump_sha256
  )
    throw new Error("Database dump hash mismatch");
  for (const item of manifest.attachments) {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(item.storage_key))
      throw new Error("Unsafe attachment key");
    const p = path.join(directory, "uploads", item.storage_key);
    if ((await stat(p)).size !== item.size || (await sha256(p)) !== item.sha256)
      throw new Error("Restored attachment hash or size mismatch");
  }
  return manifest;
}
