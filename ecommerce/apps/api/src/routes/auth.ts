import { Router } from "express";
import { z } from "zod";
import { endpoint } from "../http/route.ts";
import { email, kenyanPhone, optionalText } from "@ecom/shared";
import { fail } from "../errors.ts";
import {
  clearSessionCookie,
  createGuestSession,
  loginAdmin,
  loginCustomer,
  registerCustomer,
  revokeSession,
  setSessionCookie,
} from "../services/auth.ts";
import { hashPassword, rateLimit, verifyPassword } from "../services/security.ts";

export function registerAuthRoutes(router: Router) {
  endpoint(
    router,
    "post",
    "/auth/register",
    {
      auth: "public",
      transactional: false,
      status: 201,
      body: z
        .object({
          email,
          password: z.string().min(12).max(256),
          first_name: z.string().trim().min(1).max(100),
          last_name: z.string().trim().min(1).max(100),
          phone: kenyanPhone.optional(),
        })
        .strict(),
      summary: "Create a customer account and start a session",
      tags: ["auth"],
    },
    async ({ ctx, body }) => {
      if (ctx.actor?.kind === "admin") fail(403, "FORBIDDEN", "Administrators cannot register storefront accounts");
      const result = await registerCustomer(
        ctx.db,
        {
          email: body.email,
          password: body.password,
          firstName: body.first_name,
          lastName: body.last_name,
          phone: body.phone,
        },
        { ip: ctx.ip, userAgent: ctx.req.header("user-agent") },
      );
      setSessionCookie(ctx.res, "customer", result.token);
      return {
        data: {
          customer: {
            customer_id: result.customer.customer_id,
            email: result.customer.email,
            first_name: result.customer.first_name,
            last_name: result.customer.last_name,
          },
          csrf_token: result.csrf,
        },
      };
    },
  );

  endpoint(
    router,
    "post",
    "/auth/login",
    {
      auth: "public",
      transactional: false,
      body: z.object({ email, password: z.string().min(1).max(256) }).strict(),
      summary: "Customer sign-in",
      tags: ["auth"],
    },
    async ({ ctx, body }) => {
      const result = await loginCustomer(ctx.db, body, { ip: ctx.ip, userAgent: ctx.req.header("user-agent") });
      setSessionCookie(ctx.res, "customer", result.token);
      return {
        data: {
          customer: {
            customer_id: result.customer.customer_id,
            email: result.customer.email,
            first_name: result.customer.first_name,
            last_name: result.customer.last_name,
          },
          csrf_token: result.csrf,
        },
      };
    },
  );

  endpoint(
    router,
    "post",
    "/auth/guest",
    {
      auth: "public",
      transactional: false,
      status: 201,
      body: z.object({ email: email.optional() }).strict(),
      summary: "Start a guest checkout identity",
      tags: ["auth"],
    },
    async ({ ctx, body }) => {
      if (ctx.actor) {
        // Never silently replace an existing identity's cookie.
        return { data: { guest: false, existing: ctx.actor.kind, csrf_token: ctx.actor.kind === "admin" ? null : ctx.actor.csrf } };
      }
      const guest = await createGuestSession(ctx.db, { email: body.email ?? null }, {
        ip: ctx.ip,
        userAgent: ctx.req.header("user-agent"),
      });
      setSessionCookie(ctx.res, "guest", guest.token);
      return { data: { guest: true, guest_session_id: guest.guestSessionId, email: guest.email, csrf_token: guest.csrf } };
    },
  );

  endpoint(
    router,
    "get",
    "/auth/me",
    {
      auth: "public",
      summary: "Current identity and CSRF token",
      tags: ["auth"],
    },
    async ({ ctx }) => {
      const actor = ctx.actor;
      if (!actor) return { data: { authenticated: false } };
      if (actor.kind === "customer") {
        const customer = await ctx.db.query<any>(
          "SELECT customer_id, email, first_name, last_name, phone FROM customer WHERE customer_id = $1",
          [actor.customerId],
        );
        return { data: { authenticated: true, kind: "customer", customer: customer.rows[0], csrf_token: actor.csrf } };
      }
      if (actor.kind === "guest") {
        return { data: { authenticated: true, kind: "guest", guest_session_id: actor.guestSessionId, email: actor.email, csrf_token: actor.csrf } };
      }
      return {
        data: {
          authenticated: true,
          kind: "admin",
          admin: { admin_user_id: actor.adminUserId, email: actor.email, display_name: actor.displayName, roles: actor.roles, permissions: actor.permissions },
          csrf_token: actor.csrf,
        },
      };
    },
  );

  endpoint(
    router,
    "post",
    "/auth/logout",
    { auth: "any", transactional: false, summary: "Revoke the current session", tags: ["auth"] },
    async ({ ctx }) => {
      await revokeSession(ctx.db, ctx.actor!);
      clearSessionCookie(ctx.res, ctx.actor!.kind === "admin" ? "admin" : ctx.actor!.kind === "customer" ? "customer" : "guest");
      return { data: { signed_out: true } };
    },
  );

  endpoint(
    router,
    "post",
    "/auth/change-password",
    {
      auth: "customer",
      transactional: false,
      body: z.object({ current_password: z.string().min(1).max(256), new_password: z.string().min(12).max(256) }).strict(),
      summary: "Change a customer password and revoke other sessions",
      tags: ["auth"],
    },
    async ({ ctx, body }) => {
      const actor = ctx.actor!;
      if (actor.kind !== "customer") fail(403, "FORBIDDEN", "Customer sign-in required");
      const customerId = actor.customerId;
      await rateLimit(ctx.db, `password-change:${customerId}`, 10, 3600);
      const row = await ctx.db.query<any>("SELECT password_hash FROM customer WHERE customer_id = $1", [customerId]);
      if (!(await verifyPassword(row.rows[0]!.password_hash, body.current_password))) {
        fail(401, "UNAUTHENTICATED", "Current password is incorrect");
      }
      const hash = await hashPassword(body.new_password);
      await ctx.db.withTransaction(async (tx) => {
        await tx.query("UPDATE customer SET password_hash = $2, updated_at = now() WHERE customer_id = $1", [customerId, hash]);
        await tx.query(
          "UPDATE customer_session SET revoked_at = now() WHERE customer_id = $1 AND session_id <> $2 AND revoked_at IS NULL",
          [customerId, actor.sessionId],
        );
      });
      return { data: { changed: true, other_sessions_revoked: true } };
    },
  );

  endpoint(
    router,
    "post",
    "/admin/auth/login",
    {
      auth: "public",
      transactional: false,
      body: z.object({ email, password: z.string().min(1).max(256) }).strict(),
      summary: "Store administrator sign-in (separate identity realm)",
      tags: ["admin"],
    },
    async ({ ctx, body }) => {
      const result = await loginAdmin(ctx.db, body, { ip: ctx.ip, userAgent: ctx.req.header("user-agent") });
      setSessionCookie(ctx.res, "admin", result.token);
      return {
        data: {
          admin: {
            admin_user_id: result.admin.admin_user_id,
            email: result.admin.email,
            display_name: result.admin.display_name,
            roles: result.roles,
            permissions: result.permissions,
          },
          csrf_token: result.csrf,
        },
      };
    },
  );
}
