import { assertDatabaseReady } from "./readiness.ts";
import "dotenv/config";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { z, ZodError } from "zod";
import { pool, AppError, fail } from "./db.ts";
import { loginSchema } from "@duka/shared";
import {
  login,
  setSessionCookie,
  clearSessionCookie,
  rateLimit,
  requestReset,
  resetPassword,
} from "./services/auth.ts";
import { receiveCallback } from "./integrations/mpesa.ts";
import { api, openApi, routeRegistry } from "./http.ts";
import "./routes/index.ts";
export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "password",
    "token",
    "authorization",
    "cookie",
    "csrf_token",
    "secret",
  ],
});
function allowedOrigin(origin: string) {
  const configured = (
    process.env.ALLOWED_ORIGINS ??
    process.env.WEB_ORIGIN ??
    "http://localhost:3000"
  )
    .split(",")
    .map((s) => s.trim());
  return (
    configured.includes(origin) ||
    (process.env.NODE_ENV !== "production" &&
      (/^https:\/\/3000-[a-zA-Z0-9-]+\.e2b\.app$/.test(origin) ||
        /^http:\/\/(localhost|127\.0\.0\.1):(3000|4000)$/.test(origin)))
  );
}
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 0));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          styleSrc: ["'unsafe-inline'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-origin" },
    }),
  );
  app.use((req, res, next) => {
    const given = req.header("X-Request-Id");
    (req as any).requestId =
      given && /^[\w-]{8,100}$/.test(given) ? given : randomUUID();
    res.setHeader("X-Request-Id", (req as any).requestId);
    res.setHeader("Cache-Control", "no-store");
    const start = Date.now();
    res.on("finish", () =>
      log.info(
        {
          requestId: (req as any).requestId,
          method: req.method,
          path: req.path.includes("/callback/")
            ? "/api/v1/integrations/mpesa/callback/[REDACTED]"
            : req.path,
          status: res.statusCode,
          duration_ms: Date.now() - start,
        },
        "http",
      ),
    );
    next();
  });
  app.use((req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !req.path.startsWith("/api/v1/integrations/mpesa/callback/")
    ) {
      const origin = req.header("origin");
      if (!origin || !allowedOrigin(origin))
        return next(
          new AppError(403, "ORIGIN_DENIED", "Request origin is not allowed"),
        );
      if (req.header("Sec-Fetch-Site") === "cross-site")
        return next(
          new AppError(
            403,
            "ORIGIN_DENIED",
            "Cross-site state changes are not allowed",
          ),
        );
    }
    next();
  });
  const authJson = express.json({ limit: "16kb", strict: true });
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      res.json({ status: "ready", ...(await assertDatabaseReady()) });
    } catch {
      res.status(503).json({ status: "not_ready" });
    }
  });
  app.post("/api/v1/auth/login", authJson, async (req, res, next) => {
    try {
      const input = loginSchema.parse(req.body);
      const result = await login(input, req.ip, req.header("User-Agent"));
      setSessionCookie(res, result.token);
      res.json({
        data: { signed_in: true, csrf_token: result.csrf },
        meta: { request_id: (req as any).requestId },
      });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/v1/auth/forgot-password", authJson, async (req, res, next) => {
    try {
      const i = z
        .object({ email: z.email().transform((v) => v.toLowerCase()) })
        .strict()
        .parse(req.body);
      await requestReset(i.email, req.ip);
      res.json({
        data: {
          message:
            "If an active account exists, a password reset email has been sent.",
        },
        meta: { request_id: (req as any).requestId },
      });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/v1/auth/reset-password", authJson, async (req, res, next) => {
    try {
      await rateLimit("reset-complete:" + req.ip, 10, 900);
      const i = z
        .object({
          token: z.string().min(20).max(150),
          password: z.string().min(12).max(256),
        })
        .strict()
        .parse(req.body);
      await resetPassword(i.token, i.password);
      clearSessionCookie(res);
      res.json({
        data: { changed: true },
        meta: { request_id: (req as any).requestId },
      });
    } catch (e) {
      next(e);
    }
  });
  app.post(
    "/api/v1/integrations/mpesa/callback/:token",
    express.json({ limit: "128kb", strict: true }),
    async (req, res, next) => {
      try {
        await rateLimit("callback:" + req.ip, 120, 60);
        await receiveCallback(String(req.params.token), req.body);
        res.json({ ResultCode: 0, ResultDesc: "Accepted for verification" });
      } catch (e) {
        next(e);
      }
    },
  );
  app.get("/api/v1/openapi.json", (_req, res) => res.json(openApi()));
  app.get("/api/v1/docs", (_req, res) => {
    const esc = (s: string) =>
      s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll('"', "&quot;");
    res
      .type("html")
      .send(
        `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Duka API reference</title><style>body{font:15px system-ui;max-width:1000px;margin:40px auto;padding:20px;color:#17392e}td,th{padding:12px;text-align:left;border-bottom:1px solid #ddd}code{font-size:12px}h1{font-size:36px}a{color:#167958}</style><h1>Duka Business OS API</h1><p>Version 0.1.0 · <a href="/api/v1/openapi.json">Download OpenAPI 3.1 specification</a></p><p>Log in using POST /api/v1/auth/login (email, password, optional totp). Read /auth/me for X-CSRF-Token. Mutations require the session cookie, allowed Origin, and CSRF header. Financial commands require an Idempotency-Key. Decimal values are strings. Error responses contain code, message and request_id.</p><table><tr><th>Method</th><th>Endpoint</th><th>Permission</th><th>Description</th></tr>${routeRegistry.map((r) => `<tr><td>${r.method.toUpperCase()}</td><td><code>/api/v1${esc(r.path)}</code></td><td><code>${r.permission === undefined ? "authenticated / service-checked" : Array.isArray(r.permission) ? esc(r.permission.join(" OR ")) : esc(r.permission)}</code></td><td>${esc(r.summary)}</td></tr>`).join("")}</table></html>`,
      );
  });
  app.use("/api/v1", api);
  app.use((_req, _res, next) =>
    next(new AppError(404, "NOT_FOUND", "Endpoint not found")),
  );
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    let status = 500,
      code = "INTERNAL_ERROR",
      message =
        "An unexpected error occurred. Quote the request ID to your administrator.",
      details: unknown;
    if (err instanceof ZodError) {
      status = 422;
      code = "VALIDATION_ERROR";
      message = "Please correct the highlighted input";
      details = err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
    } else if (err instanceof AppError) {
      ({ status, code, message, details } = err);
    } else if (err.type === "entity.too.large") {
      status = 413;
      code = "PAYLOAD_TOO_LARGE";
      message = "Request exceeds the permitted size";
    } else if (err.type === "entity.parse.failed") {
      status = 400;
      code = "INVALID_JSON";
      message = "Malformed JSON body";
    } else if (err.code === "23505") {
      status = 409;
      code = "DUPLICATE_REFERENCE";
      message =
        "A unique SKU, barcode, invoice, payment reference, shift or posting already exists";
    } else if (err.code === "23503") {
      status = 422;
      code = "INVALID_REFERENCE";
      message = "A referenced record does not exist in this business";
    } else if (err.code === "23514") {
      status = 409;
      code = "INTEGRITY_GUARD";
      message =
        "The database rejected an immutable, unbalanced or inconsistent transaction";
    } else if (["22P02", "22007", "22008"].includes(err.code)) {
      status = 400;
      code = "INVALID_INPUT";
      message = "Invalid identifier or date";
    } else if (["55P03", "40P01", "40001"].includes(err.code)) {
      status = 409;
      code = "TRANSACTION_BUSY";
      message = "This record is busy. Retry with the same idempotency key";
    } else if (err.code === "57014") {
      status = 503;
      code = "QUERY_TIMEOUT";
      message = "Request timed out. Retry using the same idempotency key";
    }
    if (status >= 500)
      log.error(
        {
          requestId: (req as any).requestId,
          error: err.message,
          stack: err.stack,
        },
        "request failed",
      );
    res.status(status).json({
      error: {
        code,
        message,
        ...(details ? { details } : {}),
        request_id: (req as any).requestId,
      },
    });
  });
  return app;
}
