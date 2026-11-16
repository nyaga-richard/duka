/**
 * Test preload: set the environment BEFORE the config module is imported.
 * Each test file installs its own isolated PGlite database afterwards.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "pglite://./.pglite/test-preload";
process.env.PAYMENTS_MODE ??= "manual";
process.env.ERP_ENABLED ??= "false";
process.env.LOG_LEVEL ??= "silent";
process.env.COOKIE_SECURE ??= "false";
process.env.ALLOWED_ORIGINS ??= "http://localhost:3100";
process.env.WEB_ORIGIN ??= "http://localhost:3100";
