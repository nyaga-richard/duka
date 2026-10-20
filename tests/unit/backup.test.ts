import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  stat,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  encryptArchive,
  decryptArchive,
  extractArchive,
  run,
} from "../../scripts/backup-lib.ts";
test("backup encryption authenticates bytes and rejects corruption, wrong keys and unsafe tar links", async () => {
  process.umask(0o077);
  const dir = await mkdtemp(path.join(tmpdir(), "duka-backup-unit-"));
  try {
    const source = path.join(dir, "source"),
      encrypted = path.join(dir, "encrypted"),
      plain = path.join(dir, "plain"),
      password = randomBytes(32).toString("base64");
    await writeFile(source, randomBytes(1024));
    await encryptArchive(source, encrypted, password);
    await decryptArchive(encrypted, plain, password);
    assert.deepEqual(await readFile(plain), await readFile(source));
    assert.equal((await stat(encrypted)).mode & 0o777, 0o600);
    await assert.rejects(
      () =>
        decryptArchive(
          encrypted,
          path.join(dir, "wrong"),
          randomBytes(32).toString("base64"),
        ),
      /authenticate|Unsupported state/i,
    );
    const damaged = await readFile(encrypted);
    damaged[100] ^= 1;
    await writeFile(path.join(dir, "damaged"), damaged);
    await assert.rejects(
      () =>
        decryptArchive(
          path.join(dir, "damaged"),
          path.join(dir, "bad"),
          password,
        ),
      /authenticate|Unsupported state/i,
    );
    const unsafe = path.join(dir, "unsafe");
    await mkdir(unsafe);
    await writeFile(path.join(unsafe, "manifest.json"), "{}");
    await writeFile(path.join(unsafe, "database.dump"), "test");
    await symlink("/etc/passwd", path.join(unsafe, "uploads"));
    const tar = path.join(dir, "unsafe.tar");
    await run("tar", [
      "-C",
      unsafe,
      "-cf",
      tar,
      "database.dump",
      "manifest.json",
      "uploads",
    ]);
    await assert.rejects(
      () => extractArchive(tar, path.join(dir, "extracted")),
      /links or special files/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
