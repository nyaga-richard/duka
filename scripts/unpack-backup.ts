import "dotenv/config";
import path from "node:path";
import { mkdtemp, rm, rename, lstat } from "node:fs/promises";
import {
  decryptArchive,
  extractArchive,
  verifyExtracted,
  passphrase,
} from "./backup-lib.ts";
export async function unpackBackup(source: string, target: string) {
  process.umask(0o077);
  if (!source || !target)
    throw new Error(
      "Usage: unpack-backup <encrypted-file> <new-private-directory>",
    );
  const destination = path.resolve(target);
  try {
    await lstat(destination);
    throw new Error("Destination already exists; no files were changed");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const stage = await mkdtemp(
    path.join(path.dirname(destination), ".duka-unpack-"),
  );
  try {
    const archive = path.join(stage, "authenticated.tar");
    await decryptArchive(path.resolve(source), archive, await passphrase());
    const extracted = path.join(stage, "verified");
    await extractArchive(archive, extracted);
    const manifest = await verifyExtracted(extracted);
    await rename(extracted, destination);
    return {
      directory: destination,
      created_at: manifest.created_at,
      tables: Object.keys(manifest.fingerprints).length,
      attachments: manifest.attachments.length,
      warning:
        "Authenticated plaintext recovery files. Keep private and remove securely after recovery.",
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (/\/unpack-backup\.(ts|mjs)$/.test(process.argv[1] ?? ""))
  try {
    console.log(
      JSON.stringify(
        await unpackBackup(process.argv[2], process.argv[3]),
        null,
        2,
      ),
    );
  } catch (e: any) {
    console.error(e.message);
    process.exitCode = 1;
  }
