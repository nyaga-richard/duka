import { Router, json, type Request, type Response } from "express";
import { z } from "zod";
import {
  transaction,
  requirePermission,
  branchAccess,
  idempotent,
  type Context,
  type Actor,
} from "./db.ts";
import { authenticate, clearSessionCookie } from "./services/auth.ts";
export const api = Router();
api.use(authenticate);
// Reject unauthenticated/CSRF-invalid uploads before allocating their body.
api.use(json({ limit: "8mb", strict: true }));
export const searchQuery = z
  .object({
    q: z.string().max(160).optional(),
    page: z.coerce.number().int().min(1).max(100000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    branch_id: z.uuid().optional(),
    warehouse_id: z.uuid().optional(),
    product_id: z.uuid().optional(),
    category_id: z.uuid().optional(),
    customer_id: z.uuid().optional(),
    supplier_id: z.uuid().optional(),
    user_id: z.uuid().optional(),
    contact_id: z.uuid().optional(),
    document_type: z.enum(["invoice", "opening"]).optional(),
    account_id: z.uuid().optional(),
    low: z.enum(["true", "false"]).optional(),
    active: z.enum(["all", "true"]).optional(),
    group: z
      .enum(["product", "category", "customer", "cashier", "branch"])
      .optional(),
    movements: z.enum(["true", "false"]).optional(),
    format: z.enum(["json", "csv", "pdf"]).optional(),
    thermal: z.enum(["true", "false"]).optional(),
    status: z.string().max(30).optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: "Start date must be before end date",
  });
export const routeRegistry: {
  method: string;
  path: string;
  permission?: string;
  schema?: z.ZodType;
  summary: string;
  idempotent: boolean;
}[] = [];
export interface RawResponse {
  raw: Buffer | string;
  contentType: string;
  filename?: string;
  inline?: boolean;
}
export function endpoint(
  method: "get" | "post" | "put" | "patch" | "delete",
  path: string,
  permission: string | undefined,
  schema: z.ZodType | undefined,
  summary: string,
  fn: (ctx: Context, input: any, req: Request) => Promise<any>,
  options: {
    idempotent?: boolean;
    isolation?: "repeatable read";
    clearSession?: boolean;
    afterCommit?: (actor: Actor, result: any) => Promise<any>;
    filterResponse?: (ctx: Context, result: any) => any;
  } = {},
) {
  const idem = options.idempotent ?? !["get", "delete"].includes(method);
  routeRegistry.push({
    method,
    path,
    permission,
    schema,
    summary,
    idempotent: idem,
  });
  api[method](path, async (req, res, next) => {
    try {
      if (req.params.id) z.uuid().parse(req.params.id);
      const input =
        method === "get"
          ? searchQuery.parse(req.query)
          : schema
            ? schema.parse(req.body)
            : z
                .object({})
                .strict()
                .parse(req.body ?? {});
      const actor = (req as any).actor as Actor;
      const result = await transaction(
        actor,
        async (ctx) => {
          if (permission) requirePermission(ctx, permission);
          const selectedBranch =
            method === "get"
              ? (input as z.infer<typeof searchQuery>).branch_id
              : undefined;
          if (selectedBranch) {
            branchAccess(ctx, selectedBranch);
            const warehouses = await ctx.db.query(
              "SELECT id FROM warehouses WHERE company_id=$1 AND branch_id=$2 AND id=ANY($3::uuid[])",
              [ctx.companyId, selectedBranch, ctx.actor.warehouse_ids],
            );
            ctx.actor = {
              ...ctx.actor,
              branch_ids: [selectedBranch],
              warehouse_ids: warehouses.rows.map((w) => w.id),
            };
          }
          const data = idem
            ? await idempotent(
                ctx,
                `${method}:${path}`,
                req.header("Idempotency-Key"),
                { id: req.params.id ?? null, input },
                () => fn(ctx, input, req),
              )
            : await fn(ctx, input, req);
          return options.filterResponse
            ? options.filterResponse(ctx, data)
            : data;
        },
        (req as any).requestId,
        {
          isolation:
            options.isolation ??
            (method === "get" ? "repeatable read" : undefined),
        },
      );
      if (options.afterCommit) await options.afterCommit(actor, result);
      if (options.clearSession) clearSessionCookie(res);
      res.setHeader("Cache-Control", "no-store");
      if (result && typeof result === "object" && "raw" in result) {
        const raw = result as RawResponse;
        res.type(raw.contentType);
        if (raw.filename)
          res.setHeader(
            "Content-Disposition",
            `${raw.inline ? "inline" : "attachment"}; filename="${raw.filename.replace(/[^a-zA-Z0-9_.-]/g, "_")}"`,
          );
        res.send(raw.raw);
      } else {
        const payload = {
          data: result ?? null,
          meta: { request_id: (req as any).requestId },
        };
        z.object({
          data: z.unknown(),
          meta: z.object({ request_id: z.string() }),
        }).parse(payload);
        res.json(payload);
      }
    } catch (e) {
      next(e);
    }
  });
}
export const idOf = (req: Request) => String(req.params.id);
export function openApi() {
  const paths: Record<string, any> = {};
  for (const r of routeRegistry) {
    const path = "/api/v1" + r.path.replace(/:([A-Za-z_]+)/g, "{$1}");
    let schema: unknown;
    try {
      schema = r.schema
        ? z.toJSONSchema(r.schema, { io: "input", unrepresentable: "any" })
        : undefined;
    } catch {
      schema = { type: "object" };
    }
    paths[path] ??= {};
    paths[path][r.method] = {
      summary: r.summary,
      description: r.permission
        ? `Required permission: ${r.permission}. Tenant and branch checks are server enforced.`
        : undefined,
      tags: [r.path.split("/")[1]],
      security: [{ sessionCookie: [] }],
      parameters: [
        ...[...r.path.matchAll(/:([A-Za-z_]+)/g)].map((m) => ({
          in: "path",
          name: m[1],
          required: true,
          schema: { type: "string" },
        })),
        ...(r.idempotent
          ? [
              {
                in: "header",
                name: "Idempotency-Key",
                required: true,
                schema: { type: "string", minLength: 8, maxLength: 160 },
              },
            ]
          : []),
        ...(["get"].includes(r.method)
          ? [
              {
                in: "query",
                name: "page",
                schema: { type: "integer", default: 1 },
              },
              {
                in: "query",
                name: "limit",
                schema: { type: "integer", maximum: 100, default: 25 },
              },
              {
                in: "query",
                name: "from",
                schema: { type: "string", format: "date" },
              },
              {
                in: "query",
                name: "to",
                schema: { type: "string", format: "date" },
              },
              {
                in: "query",
                name: "branch_id",
                schema: { type: "string", format: "uuid" },
              },
            ]
          : [
              {
                in: "header",
                name: "X-CSRF-Token",
                required: true,
                schema: { type: "string" },
              },
            ]),
      ],
      ...(r.method !== "get" && schema
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema } },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "Success",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Success" },
            },
          },
        },
        "400": { description: "Invalid request" },
        "401": { description: "Unauthenticated" },
        "403": { description: "Permission, tenant, branch or CSRF denied" },
        "409": {
          description:
            "State, idempotency, duplicate, closed period or stock conflict",
        },
        "422": { description: "Business validation failure" },
        "429": { description: "Rate limited" },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Duka Business OS API",
      version: "0.1.0",
      description:
        "Decimal currency and quantity values are JSON strings. Use same-origin session cookies. Obtain CSRF token from /auth/me. Never send client totals, actor IDs or company IDs. Critical POST endpoints require unique Idempotency-Key; repeat unchanged payloads to retry safely.",
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        sessionCookie: { type: "apiKey", in: "cookie", name: "duka_session" },
      },
      schemas: {
        Success: {
          type: "object",
          required: ["data", "meta"],
          properties: {
            data: {},
            meta: {
              type: "object",
              properties: { request_id: { type: "string" } },
            },
          },
        },
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "request_id"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                details: {},
                request_id: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}
