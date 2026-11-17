/**
 * Express application factory.
 *
 * Cross-cutting order matters: request id + structured logging, then origin
 * enforcement, then body parsing that retains the raw body for webhook HMAC
 * verification, then identity resolution, then routes.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { logger } from "./logger.ts";
import type { Database } from "./db/index.ts";
import { resolveActors } from "./services/auth.ts";
import { migrationsCurrent } from "./db/migrate.ts";
import { docsHtml, openApiDocument } from "./http/route.ts";
import { errorHandler } from "./http/respond.ts";
import { createApiRouter } from "./routes/index.ts";
import { AppError } from "./errors.ts";

function originAllowed(origin: string): boolean {
  if (config.allowedOrigins.includes(origin)) return true;
  if (config.isProduction) return false;
  // Isolated preview hosts used by the sandbox viewer.
  return (
    /^https:\/\/[a-z0-9-]+\.e2b\.app$/.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)
  );
}

export interface AppDependencies {
  db: Database;
}

export function createApp({ db }: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", config.trustProxy);

  // Nobody may frame the API in production. In development it has to be framable
  // by the sandbox preview viewer, whose origin is a *.e2b.app host — the same
  // exception `originAllowed` already makes for state changes.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          styleSrc: ["'unsafe-inline'"],
          frameAncestors: config.isProduction
            ? ["'none'"]
            : ["'self'", "https://*.e2b.app", "http://localhost:*"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-origin" },
      frameguard: config.isProduction ? { action: "sameorigin" } : false,
    }),
  );

  app.use((req, res, next) => {
    const given = req.header("X-Request-Id");
    const requestId = given && /^[\w-]{8,100}$/.test(given) ? given : randomUUID();
    (req as any).requestId = requestId;
    (req as any).db = db;
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    const started = Date.now();
    res.on("finish", () => {
      const path = req.path.startsWith("/api/v1/webhooks/")
        ? "/api/v1/webhooks/[redacted]"
        : req.path;
      logger.info(
        {
          request_id: requestId,
          method: req.method,
          path,
          status: res.statusCode,
          duration_ms: Date.now() - started,
        },
        "http",
      );
    });
    next();
  });

  // The ERP-style origin allowlist: browsers must present an allowed Origin on
  // state changes. Provider webhooks are server-to-server and are authenticated
  // by HMAC signature instead.
  app.use((req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.path.startsWith("/api/v1/webhooks/")) return next();
    const origin = req.header("origin");
    if (!origin || !originAllowed(origin)) {
      return next(new AppError(403, "ORIGIN_DENIED", "Request origin is not allowed"));
    }
    next();
  });

  app.use(
    express.json({
      limit: "256kb",
      strict: true,
      verify: (req, _res, buffer) => {
        (req as any).rawBody = buffer.toString("utf8");
      },
    }),
  );

  app.get("/health/live", (_req, res) => res.json({ status: "ok", service: "ecommerce-api" }));

  app.get("/health/ready", async (_req, res) => {
    const database = await db.healthCheck();
    const migrations = database.ok ? await migrationsCurrent(db) : false;
    const workers = database.ok
      ? await db.query<{ last_seen_at: string; age_seconds: number }>(
          `SELECT max(last_seen_at)::text AS last_seen_at,
                  extract(epoch FROM (now() - max(last_seen_at)))::int AS age_seconds
             FROM worker_heartbeat`,
        )
      : { rows: [] as any[] };
    const heartbeat = workers.rows[0];
    const workerStale = !heartbeat?.last_seen_at || Number(heartbeat.age_seconds ?? 1e9) > 120;
    const ready = database.ok && migrations;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      checks: {
        database,
        migrations_current: migrations,
        worker: {
          last_seen_at: heartbeat?.last_seen_at ?? null,
          age_seconds: heartbeat?.age_seconds ?? null,
          stale: workerStale,
          required: config.isProduction,
        },
        erp_enabled: config.erp.enabled,
        payments_mode: config.payments.mode,
        payment_capture_enabled: config.payments.captureEnabled,
      },
      version: "0.1.0",
    });
  });

  // Identity resolution must be registered BEFORE the routes: Express runs the
  // router stack in registration order, so attaching it afterwards would leave
  // every handler with an unresolved actor.
  const api = express.Router();
  api.use(async (req: Request, _res: Response, next: NextFunction) => {
    try {
      (req as any).actors = await resolveActors(db, req);
      next();
    } catch (error) {
      next(error);
    }
  });
  api.use(createApiRouter());

  app.get("/api/v1/openapi.json", (_req, res) => res.json(openApiDocument()));
  app.get("/api/v1/docs", (_req, res) => res.type("html").send(docsHtml()));

  // A browser landing on the origin — or a preview pane opening it — gets the
  // route index instead of a bare 404.
  app.get("/", (_req, res) => res.type("html").send(docsHtml()));

  app.use("/api/v1", api);

  app.use((_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Endpoint not found")));
  app.use(errorHandler());
  return app;
}
