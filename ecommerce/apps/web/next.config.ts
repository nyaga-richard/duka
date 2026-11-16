import type { NextConfig } from "next";

/**
 * The browser only ever talks to this Next app. Every `/api/v1/*` request is
 * proxied server-side to the Express API, which keeps cookies first-party and
 * means the API never needs to be exposed to the public internet.
 */
const apiInternal = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4100";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: "/api/v1/:path*", destination: `${apiInternal}/api/v1/:path*` },
      { source: "/health/:path*", destination: `${apiInternal}/health/:path*` },
    ];
  },
};

export default nextConfig;
