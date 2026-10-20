import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";
if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error(
    "E2E tests require a separate TEST_DATABASE_URL ending in _test",
  );
const web = "http://127.0.0.1:3100";
const devWeb = process.env.E2E_WEB_MODE === "development";
const env = {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "development",
  WORKSPACE_PREVIEW: "false",
  MPESA_MODE: "mock",
  ETIMS_MODE: "disabled",
  DEMO_MODE: "true",
  COOKIE_SECURE: "false",
  TRUST_PROXY: "0",
  WEB_ORIGIN: web,
  ALLOWED_ORIGINS: web,
  MAIL_MODE: "outbox",
  UPLOAD_DIR: new URL("./artifacts/test-uploads", import.meta.url).pathname,
  MFA_ENCRYPTION_KEY: "isolated-e2e-encryption-key-not-for-production",
};
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 12000 },
  retries: 0,
  outputDir: "artifacts/e2e",
  reporter: [
    ["list"],
    ["html", { outputFolder: "artifacts/e2e-report", open: "never" }],
  ],
  use: {
    baseURL: web,
    actionTimeout: 20000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
  webServer: [
    {
      command: "npm run db:migrate && npm run dev:api",
      url: "http://127.0.0.1:4100/health/ready",
      reuseExistingServer: false,
      timeout: 90000,
      env: { ...env, PORT: "4100" },
    },
    {
      command: devWeb
        ? "npx next dev apps/web --hostname 0.0.0.0 --port 3100"
        : (process.env.E2E_REUSE_BUILD === "true"
            ? ""
            : "npx next build apps/web --webpack && ") +
          "node scripts/e2e-web.mjs",
      url: web,
      reuseExistingServer: false,
      timeout: 180000,
      env: {
        ...env,
        NODE_ENV: devWeb ? "development" : "production",
        API_INTERNAL_URL: "http://127.0.0.1:4100",
        NEXT_BUILD_DIR: devWeb
          ? ".cache/next-e2e"
          : ".cache/next-e2e-production",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
