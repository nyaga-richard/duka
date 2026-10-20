import "dotenv/config";
// A Node preload, deliberately BEFORE any app module can construct its pool.
// Relying on test import order silently connected one new test file to dev.
const target = process.env.TEST_DATABASE_URL;
if (!target || !new URL(target).pathname.endsWith("_test"))
  throw new Error("Tests require a separate TEST_DATABASE_URL ending in _test");
process.env.DATABASE_URL = target;
process.env.NODE_ENV = "test";
process.env.WORKSPACE_PREVIEW = "false";
process.env.MAIL_MODE = "outbox";
process.env.MPESA_MODE = "mock";
process.env.DEMO_MODE = "true";
process.env.ETIMS_MODE = "disabled";
process.env.UPLOAD_DIR = new URL(
  "../artifacts/test-uploads",
  import.meta.url,
).pathname;
