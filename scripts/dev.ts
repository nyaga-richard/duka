import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
const children: ChildProcess[] = [];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children)
    if (child.pid)
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
  setTimeout(() => process.exit(code), 1000).unref();
}
for (const args of [
  ["node_modules/tsx/dist/cli.mjs", "watch", "apps/api/src/index.ts"],
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "apps/web",
    "--hostname",
    "0.0.0.0",
    "--port",
    "3000",
  ],
]) {
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    detached: true,
    env: {
      ...process.env,
      NEXT_BUILD_DIR: process.env.NEXT_BUILD_DIR ?? ".cache/next-preview",
    },
  });
  children.push(child);
  child.on("error", (e) => {
    console.error(e.message);
    close(1);
  });
  child.on("exit", (code) => close(code ?? 1));
}
process.on("SIGINT", () => close());
process.on("SIGTERM", () => close());
