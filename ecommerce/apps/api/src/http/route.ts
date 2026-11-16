/**
 * Route registration, validation, authentication enforcement, idempotency and
 * OpenAPI generation.
 *
 * Every API route is registered through `endpoint()` so the runtime docs page
 * and `/api/v1/openapi.json` describe actual code, not a hand-written list.
 */
import { createHash } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z, ZodError, type ZodType } from "zod";
import type { Database, Transaction } from "../db/index.ts";
import { fail } from "../errors.ts";
import type { Actor, RequestContext } from "./context.ts";
import { sendData } from "./respond.ts";
import { requireAnyPermission, verifyCsrf } from "../services/auth.ts";
import type { Permission } from "@ecom/shared";

export type AuthMode = "public" | "customer" | "customer_or_guest" | "admin" | "any";

export interface EndpointOptions {
  auth?: AuthMode;
  permissions?: Permission[];
  body?: ZodType;
  query?: ZodType;
  summary: string;
  idempotent?: boolean;
  transactional?: boolean;
  status?: number;
  tags?: string[];
}

export interface RouteInput {
  ctx: RequestContext;
  body: any;
  query: any;
  tx: Transaction | null;
}

export interface RouteResult {
  status?: number;
  data: unknown;
  /**
   * Side effects that must happen after the database transaction commits:
   * provider calls, ERP queueing. Runs once, outside the transaction; mutating
   * `data` here updates the response (and the stored idempotency response).
   */
  afterCommit?: (data: any) => Promise<void> | void;
}

type RouteHandler = (input: RouteInput) => Promise<RouteResult>;

export interface RegisteredRoute {
  method: "get" | "post" | "patch" | "put" | "delete";
  path: string;
  summary: string;
  auth: AuthMode;
  permissions: Permission[];
  idempotent: boolean;
  body?: ZodType;
  query?: ZodType;
  tags: string[];
}

export const routeRegistry: RegisteredRoute[] = [];

export function selectActor(ctx: RequestContext, mode: AuthMode): Actor | null {
  const actors = (ctx.req as any).actors as
    | { customer: Actor | null; guest: Actor | null; admin: Actor | null }
    | undefined;
  const customer = actors?.customer ?? null;
  const guest = actors?.guest ?? null;
  const admin = actors?.admin ?? null;

  switch (mode) {
    case "public":
      return admin ?? customer ?? guest ?? null;
    case "any":
      if (!admin && !customer && !guest) fail(401, "UNAUTHENTICATED", "Please sign in");
      return admin ?? customer ?? guest;
    case "customer":
      if (!customer) fail(401, "UNAUTHENTICATED", "Customer sign-in required");
      return customer;
    case "customer_or_guest":
      if (!customer && !guest) fail(401, "UNAUTHENTICATED", "A customer or guest session is required");
      return customer ?? guest;
    case "admin":
      if (!admin) {
        fail(401, "UNAUTHENTICATED", "Store administrator sign-in required");
      }
      return admin;
  }
}

function requireAdmin(actor: Actor | null, permissions: Permission[]): NonNullable<RequestContext["actor"]> {
  if (!actor || actor.kind !== "admin") fail(401, "UNAUTHENTICATED", "Store administrator sign-in required");
  if (permissions.length) requireAnyPermission(actor, permissions);
  return actor;
}

export function endpoint(
  router: Router,
  method: RegisteredRoute["method"],
  path: string,
  options: EndpointOptions,
  handler: RouteHandler,
): void {
  const auth = options.auth ?? "public";
  const transactional = options.transactional ?? method !== "get";
  const registered: RegisteredRoute = {
    method,
    path: `/api/v1${path}`,
    summary: options.summary,
    auth,
    permissions: options.permissions ?? [],
    idempotent: Boolean(options.idempotent),
    body: options.body,
    query: options.query,
    tags: options.tags ?? [path.split("/")[1] ?? "root"],
  };
  routeRegistry.push(registered);

  router[method](path, async (req: Request, res: Response, next: NextFunction) => {
    const decorated = req as Request & { db: Database; requestId: string };
    const ctx: RequestContext = {
      req,
      res,
      db: decorated.db,
      requestId: decorated.requestId,
      ip: req.ip ?? req.socket?.remoteAddress ?? "unknown",
      actor: null,
      startedAt: Date.now(),
    };
    try {
      const actor = selectActor(ctx, auth);
      ctx.actor = actor;

      if (actor && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        verifyCsrf(actor, req.header("X-CSRF-Token"));
      }
      if (auth === "admin") requireAdmin(actor, registered.permissions);

      const query = options.query ? options.query.parse(req.query) : undefined;
      const body = options.body ? options.body.parse(req.body ?? {}) : undefined;
      const key = req.header("Idempotency-Key");

      let result: RouteResult;
      if (options.idempotent) {
        if (!key) {
          fail(422, "IDEMPOTENCY_REQUIRED", "Idempotency-Key header is required for this operation");
        }
        result = await runIdempotent(
          ctx.db,
          {
            scope: `${method} ${path}`,
            key: key!,
            request: { params: req.params ?? {}, body: body ?? null },
          },
          async (tx) => handler({ ctx, body, query, tx }),
        );
      } else if (transactional) {
        result = await ctx.db.withTransaction(async (tx) => handler({ ctx, body, query, tx }));
      } else {
        result = await handler({ ctx, body, query, tx: null });
      }

      // Post-commit side effects (payment provider, ERP queue) run here, once.
      if (result.afterCommit) {
        await result.afterCommit(result.data);
        if (options.idempotent && !(result as any).replayed) {
          // Refresh the replay record so a retry sees the final response.
          await ctx.db.query(
            "UPDATE idempotency_key SET response = $3, status_code = $4 WHERE scope = $1 AND key = $2",
            [
              `${method} ${path}`,
              key,
              JSON.stringify({ data: result.data }),
              result.status ?? options.status ?? 200,
            ],
          );
        }
      }

      sendData(res, ctx.requestId, result.data, result.status ?? options.status ?? 200);
    } catch (error) {
      next(error);
    }
  });
}

/** Deterministic JSON for request hashing. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export const idempotencyHash = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");

/**
 * Execute an operation at most once per (scope, key).
 *
 * The idempotency row is written in the same transaction as the operation: a
 * failed attempt rolls back and can be retried, a successful one is replayed
 * byte-for-byte for the same request payload, and a different payload with the
 * same key is rejected rather than silently returning another order.
 */
export async function runIdempotent<T>(
  db: Database,
  input: { scope: string; key: string; request: unknown },
  handler: (tx: Transaction) => Promise<RouteResult>,
): Promise<RouteResult> {
  const hash = idempotencyHash(input.request);
  return db.withTransaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO idempotency_key(scope, key, request_hash, status)
       VALUES($1,$2,$3,'in_progress')
       ON CONFLICT (scope, key) DO NOTHING
       RETURNING scope`,
      [input.scope, input.key, hash],
    );

    if (inserted.rowCount === 0) {
      const existing = await tx.query<{
        request_hash: string;
        status: string;
        response: any;
        status_code: number | null;
      }>("SELECT request_hash, status, response, status_code FROM idempotency_key WHERE scope=$1 AND key=$2", [
        input.scope,
        input.key,
      ]);
      const row = existing.rows[0];
      if (!row) fail(409, "CONFLICT", "Idempotency record disappeared; retry the request");
      if (row.request_hash !== hash) {
        fail(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This Idempotency-Key was already used with a different request payload",
        );
      }
      if (row.status !== "completed") {
        fail(409, "IDEMPOTENCY_IN_PROGRESS", "An identical request is still in progress");
      }
      return { status: row.status_code ?? 200, data: row.response?.data ?? null, replayed: true } as RouteResult;
    }

    const result = await handler(tx);
    await tx.query(
      "UPDATE idempotency_key SET status='completed', status_code=$3, response=$4 WHERE scope=$1 AND key=$2",
      [input.scope, input.key, result.status ?? 200, JSON.stringify({ data: result.data })],
    );
    return result;
  });
}

function jsonSchema(schema?: ZodType) {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch {
    return { type: "object" };
  }
}

export function openApiDocument() {
  const paths: Record<string, any> = {};
  for (const route of routeRegistry) {
    const path = route.path.replace(/:([A-Za-z_]+)/g, "{$1}");
    const parameters = [
      ...[...route.path.matchAll(/:([A-Za-z_]+)/g)].map((match) => ({
        in: "path",
        name: match[1],
        required: true,
        schema: { type: "string" },
      })),
      ...(route.idempotent
        ? [
            {
              in: "header",
              name: "Idempotency-Key",
              required: true,
              schema: { type: "string", minLength: 8, maxLength: 160 },
            },
          ]
        : []),
      ...(route.method !== "get"
        ? [{ in: "header", name: "X-CSRF-Token", required: route.auth !== "public", schema: { type: "string" } }]
        : []),
    ];
    paths[path] ??= {};
    paths[path]![route.method] = {
      summary: route.summary,
      tags: route.tags,
      security:
        route.auth === "public"
          ? []
          : route.auth === "admin"
            ? [{ adminSession: [] }]
            : [{ customerSession: [] }, { guestSession: [] }],
      parameters,
      ...(route.body && route.method !== "get"
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: jsonSchema(route.body) } },
            },
          }
        : {}),
      responses: {
        "200": { description: "Success" },
        "401": { description: "Unauthenticated" },
        "403": { description: "Permission, CSRF or origin denied" },
        "409": { description: "Conflict, stock or idempotency problem" },
        "422": { description: "Validation failure" },
        "429": { description: "Rate limited" },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Duka E-commerce API",
      version: "0.1.0",
      description:
        "Phase 1 foundation API. Money is always a decimal string. Mutations need the session cookie, an allowed Origin, and X-CSRF-Token. Checkout, refunds and admin sync require Idempotency-Key.",
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        customerSession: { type: "apiKey", in: "cookie", name: "ecom_session" },
        guestSession: { type: "apiKey", in: "cookie", name: "ecom_guest" },
        adminSession: { type: "apiKey", in: "cookie", name: "ecom_admin_session" },
      },
    },
  };
}

export function docsHtml() {
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const rows = routeRegistry
    .map(
      (route) =>
        `<tr><td><code>${route.method.toUpperCase()}</code></td><td><code>${escape(route.path)}</code></td><td>${escape(route.auth)}</td><td>${escape(route.permissions.join(" OR ") || "—")}</td><td>${route.idempotent ? "required" : "—"}</td><td>${escape(route.summary)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Duka E-commerce API</title>
<style>
body{font:15px/1.5 system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#17392e}
h1{font-size:32px;margin-bottom:4px}
table{border-collapse:collapse;width:100%;margin-top:24px}
th,td{padding:10px;text-align:left;border-bottom:1px solid #dbe4df;vertical-align:top}
code{font-size:12.5px;background:#f3f7f5;padding:1px 4px;border-radius:3px}
a{color:#167958}
</style></head><body>
<h1>Duka E-commerce API</h1>
<p>Version 0.1.0 · <a href="/api/v1/openapi.json">OpenAPI 3.1 JSON</a></p>
<p>Money values are decimal strings. Authenticated mutations require the session cookie, an allowed <code>Origin</code> and the <code>X-CSRF-Token</code> returned by the sign-in endpoint. Checkout, refunds and ERP syncs require <code>Idempotency-Key</code>.</p>
<table><thead><tr><th>Method</th><th>Path</th><th>Authentication</th><th>Permission</th><th>Idempotency</th><th>Description</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
}

export { ZodError };
