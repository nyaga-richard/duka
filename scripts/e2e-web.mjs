import { cp } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Build output is deliberately separate from both preview and release builds.
const web = path.resolve("apps/web"),
  dist = process.env.NEXT_BUILD_DIR ?? ".cache/next-e2e-production";
const standalone = path.join(web, dist, "standalone", "apps", "web");
await cp(path.join(web, "package.json"), path.join(standalone, "package.json"));
await cp(path.join(web, "public"), path.join(standalone, "public"), {
  recursive: true,
});
await cp(
  path.join(web, dist, "static"),
  path.join(standalone, dist, "static"),
  { recursive: true },
);
process.env.HOSTNAME = "0.0.0.0";
process.env.PORT = "3100";
await import(pathToFileURL(path.join(standalone, "server.js")).href);
