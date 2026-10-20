import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await mkdir("artifacts/server", { recursive: true });
// Bundle workspace TypeScript, but load installed native/third-party packages at runtime.
// --packages=external alone would leave @duka/* .ts imports that Node cannot execute.
await build({
  entryPoints: {
    api: "apps/api/src/index.ts",
    migrate: "scripts/migrate.ts",
    setup: "scripts/setup.ts",
    reconcile: "scripts/reconcile.ts",
    backup: "scripts/backup.ts",
    "unpack-backup": "scripts/unpack-backup.ts",
    "restore-test": "scripts/restore-test.ts",
  },
  outdir: "artifacts/server",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: "external",
  sourcesContent: false,
  external: Object.keys(pkg.dependencies).filter(
    (n: string) => !n.startsWith("@duka/"),
  ),
});
