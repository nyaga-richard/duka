import "dotenv/config";
import { spawn } from "node:child_process";
import { cp, access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
if (process.env.NODE_ENV === "production" || process.env.DEMO_MODE !== "true")
  throw new Error(
    "Workspace web commands require an explicitly isolated development/demo configuration; never point this at a production workspace",
  );
const dist = process.env.WORKSPACE_BUILD_DIR ?? ".cache/next-workspace";
if (!/^\.cache\/next-workspace(?:-[a-zA-Z0-9_-]+)?$/.test(dist))
  throw new Error(
    "Use an isolated .cache/next-workspace[-revision] build directory",
  );
if (process.argv.includes("--build")) {
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "build", "apps/web", "--webpack"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "production",
        DEMO_MODE: "true",
        NEXT_BUILD_DIR: dist,
        API_INTERNAL_URL:
          process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  child.on("error", (e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  const web = path.resolve("apps/web"),
    standalone = path.join(web, dist, "standalone", "apps", "web");
  await access(path.join(standalone, "server.js"));
  await cp(
    path.join(web, "package.json"),
    path.join(standalone, "package.json"),
  );
  await cp(path.join(web, "public"), path.join(standalone, "public"), {
    recursive: true,
  });
  await cp(
    path.join(web, dist, "static"),
    path.join(standalone, dist, "static"),
    { recursive: true },
  );
  process.env.HOSTNAME = "0.0.0.0";
  process.env.PORT = process.env.WORKSPACE_WEB_PORT ?? "3000";
  // Only this explicit demo launcher allows Arena's viewer (and local TLS smoke
  // parents). Normal production output retains the default self-only frame policy.
  process.env.FRAME_ANCESTORS ??=
    "'self' https://arena.ai https://*.arena.ai https://lmarena.ai https://*.lmarena.ai https://localhost:* https://127.0.0.1:*";
  await import(pathToFileURL(path.join(standalone, "server.js")).href);
}
