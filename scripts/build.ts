/**
 * Production build: bundles the API and the worker to `dist/` with esbuild.
 *
 * Dependencies stay external (they are installed from the lockfile in the
 * runtime image); only our TypeScript is bundled. The web app is built by
 * `next build` (npm run build:web).
 */
import { build } from "esbuild";
import { rm, mkdir } from "node:fs/promises";

const outdir = "dist";

async function main() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const common = {
    bundle: true,
    platform: "node" as const,
    format: "esm" as const,
    target: "node22",
    packages: "external" as const,
    // Workspace packages are bundled: the runtime image prunes dev dependencies
    // and must not depend on npm's workspace symlinks surviving that prune.
    alias: {
      "@ecom/shared": "./packages/shared/src/index.ts",
      "@ecom/payments": "./packages/payments/src/index.ts",
      "@ecom/erp-adapter": "./packages/erp-adapter/src/index.ts",
    },
    sourcemap: true,
    logLevel: "info" as const,
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        "const require = __createRequire(import.meta.url);",
      ].join("\n"),
    },
  };

  await Promise.all([
    build({
      ...common,
      entryPoints: ["apps/api/src/index.ts"],
      outfile: `${outdir}/api.mjs`,
    }),
    build({
      ...common,
      entryPoints: ["apps/api/src/worker.ts"],
      outfile: `${outdir}/worker.mjs`,
    }),
    build({
      ...common,
      entryPoints: ["scripts/migrate.ts"],
      outfile: `${outdir}/migrate.mjs`,
    }),
    build({
      ...common,
      entryPoints: ["database/seeds/phase1.ts"],
      outfile: `${outdir}/seed.mjs`,
    }),
  ]);

  console.log(
    "Built dist/api.mjs, dist/worker.mjs, dist/migrate.mjs, dist/seed.mjs",
  );
}

main().catch((error) => {
  console.error("build failed:", error);
  process.exit(1);
});
