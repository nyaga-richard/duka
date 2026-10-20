import { cp, mkdir, rm } from "node:fs/promises";
const output = "artifacts/web";
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp("apps/web/.next/standalone", output, {
  recursive: true,
  dereference: true,
});
await cp("apps/web/.next/static", output + "/apps/web/.next/static", {
  recursive: true,
});
await cp("apps/web/package.json", output + "/apps/web/package.json");
await cp("apps/web/public", output + "/apps/web/public", { recursive: true });
console.log("Prepared portable standalone frontend under artifacts/web");
