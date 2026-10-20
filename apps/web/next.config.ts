import "dotenv/config";
import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const config: NextConfig = {
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  output: "standalone",
  poweredByHeader: false,
  distDir: process.env.NEXT_BUILD_DIR ?? ".next",
  allowedDevOrigins: ["*.e2b.app", "localhost", "127.0.0.1"],
  transpilePackages: ["@duka/shared"],
  env: {
    NEXT_PUBLIC_DEMO_MODE: process.env.DEMO_MODE === "true" ? "true" : "false",
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000"}/api/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
    ];
  },
  experimental: { cpus: 1 },
};
export default config;
