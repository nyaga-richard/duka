/**
 * Authentication for the three identity realms.
 *
 * Cookies are opaque random tokens; only their SHA-256 digests are stored.
 * Every mutation additionally requires the per-session CSRF token.
 * Customer, guest and admin sessions live in separate tables and separate
 * cookies so privilege realms can never be confused.
 */
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import type { Request, Response } from "express";
import type { Database, Queryable } from "../db/index.ts";
import { config } from "../config.ts";
import { fail } from "../errors.ts";
import type { Actor, AdminActor, CustomerActor, GuestActor } from "../http/context.ts";
import type { Permission } from "@ecom/shared";
import {
  hashPassword,
  randomToken,
  rateLimit,
  securityEvent,
  sha256,
  verifyDummyPassword,
  verifyPassword,
} from "./security.ts";

interface SessionRow {
  session_id: string;
  csrf_token: string;
  customer_id?: number;
  guest_session_id?: string;
  admin_user_id?: string;
  email?: string | null;
  first_name?: string;
  last_name?: string;
  display_name?: string;
}

const digest = (token: string) => sha256(token);

function cookieOptions(maxAgeSeconds: number, strict = false) {
  return {
    httpOnly: true,
    sameSite: strict ? ("strict" as const) : ("lax" as const),
    secure: config.cookieSecure,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function setSessionCookie(res: Response, kind: "customer" | "guest" | "admin", token: string) {
  const maxAge =
    kind === "admin"
      ? config.sessions.adminHours * 3600
      : kind === "guest"
        ? config.sessions.guestHours * 3600
        : config.sessions.customerHours * 3600;
  res.append(
    "Set-Cookie",
    serializeCookie(config.cookieNames[kind], token, cookieOptions(maxAge, kind === "admin")),
  );
}

export function clearSessionCookie(res: Response, kind: "customer" | "guest" | "admin") {
  res.append(
    "Set-Cookie",
    serializeCookie(config.cookieNames[kind], "", { ...cookieOptions(0, kind === "admin"), maxAge: 0 }),
  );
}

export interface ResolvedActors {
  customer: CustomerActor | null;
  guest: GuestActor | null;
  admin: AdminActor | null;
}

/** Resolve every realm present in the request (usually exactly one). */
export async function resolveActors(db: Database, req: Request): Promise<ResolvedActors> {
  const cookies = parseCookie(req.headers.cookie ?? "");
  const result: ResolvedActors = { customer: null, guest: null, admin: null };

  const customerToken = cookies[config.cookieNames.customer];
  if (customerToken) {
    const rows = await db.query<SessionRow>(
      `SELECT s.session_id, s.csrf_token, c.customer_id, c.email, c.first_name, c.last_name
         FROM customer_session s
         JOIN customer c ON c.customer_id = s.customer_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND c.status = 'active'`,
      [digest(customerToken)],
    );
    const row = rows.rows[0];
    if (row) {
      result.customer = {
        kind: "customer",
        customerId: row.customer_id!,
        sessionId: row.session_id,
        email: row.email!,
        firstName: row.first_name!,
        lastName: row.last_name!,
        csrf: row.csrf_token,
      };
    }
  }

  const guestToken = cookies[config.cookieNames.guest];
  if (guestToken) {
    const rows = await db.query<SessionRow>(
      `SELECT guest_session_id, csrf_token, email
         FROM guest_session
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [digest(guestToken)],
    );
    const row = rows.rows[0];
    if (row) {
      result.guest = {
        kind: "guest",
        guestSessionId: row.guest_session_id!,
        sessionId: row.guest_session_id!,
        email: row.email ?? null,
        csrf: row.csrf_token,
      };
    }
  }

  const adminToken = cookies[config.cookieNames.admin];
  if (adminToken) {
    const rows = await db.query<SessionRow>(
      `SELECT s.session_id, s.csrf_token, u.admin_user_id, u.email, u.display_name
         FROM admin_session s
         JOIN admin_user u ON u.admin_user_id = s.admin_user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.status = 'active'`,
      [digest(adminToken)],
    );
    const row = rows.rows[0];
    if (row) {
      const [roles, permissions] = await Promise.all([
        db.query<{ role_name: string }>(
          `SELECT r.role_name FROM admin_user_role ur
             JOIN admin_role r ON r.role_id = ur.role_id
            WHERE ur.admin_user_id = $1`,
          [row.admin_user_id],
        ),
        db.query<{ permission_code: Permission }>(
          `SELECT DISTINCT rp.permission_code
             FROM admin_user_role ur
             JOIN admin_role_permission rp ON rp.role_id = ur.role_id
            WHERE ur.admin_user_id = $1`,
          [row.admin_user_id],
        ),
      ]);
      result.admin = {
        kind: "admin",
        adminUserId: row.admin_user_id!,
        sessionId: row.session_id,
        email: row.email!,
        displayName: row.display_name!,
        roles: roles.rows.map((r) => r.role_name),
        permissions: permissions.rows.map((p) => p.permission_code),
        csrf: row.csrf_token,
      };
    }
  }

  return result;
}

export function verifyCsrf(actor: Actor, provided: string | undefined) {
  const expected = actor.csrf;
  if (!provided || provided.length !== expected.length) {
    fail(403, "CSRF_INVALID", "Security token is missing or invalid");
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (!a.equals(b)) fail(403, "CSRF_INVALID", "Security token is missing or invalid");
}

interface CreateSessionInput {
  ip?: string;
  userAgent?: string;
}

async function insertCustomerSession(
  db: Database,
  customerId: number,
  input: CreateSessionInput,
): Promise<{ token: string; csrf: string; sessionId: string }> {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const row = await db.query<{ session_id: string }>(
    `INSERT INTO customer_session(customer_id, token_hash, csrf_token, expires_at, ip, user_agent)
     VALUES($1,$2,$3, now() + ($4 || ' hours')::interval, $5, $6) RETURNING session_id`,
    [customerId, digest(token), csrf, String(config.sessions.customerHours), input.ip ?? null, input.userAgent ?? null],
  );
  return { token, csrf, sessionId: row.rows[0]!.session_id };
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

export async function registerCustomer(
  db: Database,
  input: RegisterInput,
  meta: CreateSessionInput,
): Promise<{ customer: any; token: string; csrf: string }> {
  await rateLimit(db, `register:${meta.ip ?? "unknown"}`, 10, 3600);
  const existing = await db.query("SELECT 1 FROM customer WHERE email = $1", [input.email]);
  if (existing.rowCount > 0) {
    fail(409, "EMAIL_TAKEN", "An account with that email already exists");
  }
  const passwordHash = await hashPassword(input.password);
  const inserted = await db.query<any>(
    `INSERT INTO customer(email, password_hash, first_name, last_name, phone)
     VALUES($1,$2,$3,$4,$5)
     RETURNING customer_id, email, first_name, last_name, phone, created_at`,
    [input.email, passwordHash, input.firstName, input.lastName, input.phone ?? null],
  );
  const customer = inserted.rows[0];
  const session = await insertCustomerSession(db, customer.customer_id, meta);
  await securityEvent(db, {
    subjectType: "customer",
    subjectId: String(customer.customer_id),
    action: "customer.registered",
    ip: meta.ip,
  });
  return { customer, token: session.token, csrf: session.csrf };
}

export async function loginCustomer(
  db: Database,
  input: { email: string; password: string },
  meta: CreateSessionInput,
): Promise<{ customer: any; token: string; csrf: string }> {
  await rateLimit(db, `login:ip:${meta.ip ?? "unknown"}`, 40, 900);
  await rateLimit(db, `login:email:${input.email}`, 10, 900);
  const found = await db.query<any>(
    "SELECT customer_id, email, first_name, last_name, password_hash, status FROM customer WHERE email = $1",
    [input.email],
  );
  const customer = found.rows[0];
  const valid = customer
    ? await verifyPassword(customer.password_hash, input.password)
    : (await verifyDummyPassword(input.password), false);

  if (!customer || !valid || customer.status !== "active") {
    await securityEvent(db, {
      subjectType: "customer",
      subjectId: customer ? String(customer.customer_id) : null,
      action: "customer.login_failed",
      ip: meta.ip,
    });
    fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }

  const session = await insertCustomerSession(db, customer.customer_id, meta);
  await db.query("UPDATE customer SET last_login_at = now() WHERE customer_id = $1", [customer.customer_id]);
  await securityEvent(db, {
    subjectType: "customer",
    subjectId: String(customer.customer_id),
    action: "customer.login",
    ip: meta.ip,
  });
  delete customer.password_hash;
  return { customer, token: session.token, csrf: session.csrf };
}

export async function createGuestSession(
  db: Database,
  input: { email?: string | null },
  meta: CreateSessionInput,
): Promise<{ token: string; csrf: string; guestSessionId: string; email: string | null }> {
  await rateLimit(db, `guest:${meta.ip ?? "unknown"}`, 60, 3600);
  const token = randomToken(32);
  const csrf = randomToken(24);
  const row = await db.query<{ guest_session_id: string }>(
    `INSERT INTO guest_session(token_hash, csrf_token, email, expires_at, ip, user_agent)
     VALUES($1,$2,$3, now() + ($4 || ' hours')::interval, $5, $6)
     RETURNING guest_session_id`,
    [digest(token), csrf, input.email ?? null, String(config.sessions.guestHours), meta.ip ?? null, meta.userAgent ?? null],
  );
  return { token, csrf, guestSessionId: row.rows[0]!.guest_session_id, email: input.email ?? null };
}

export async function loginAdmin(
  db: Database,
  input: { email: string; password: string },
  meta: CreateSessionInput,
): Promise<{ admin: any; token: string; csrf: string; permissions: Permission[]; roles: string[] }> {
  await rateLimit(db, `admin-login:ip:${meta.ip ?? "unknown"}`, 20, 900);
  await rateLimit(db, `admin-login:email:${input.email}`, 10, 900);
  const found = await db.query<any>(
    "SELECT admin_user_id, email, display_name, password_hash, status FROM admin_user WHERE email = $1",
    [input.email],
  );
  const admin = found.rows[0];
  const valid = admin
    ? await verifyPassword(admin.password_hash, input.password)
    : (await verifyDummyPassword(input.password), false);
  if (!admin || !valid || admin.status !== "active") {
    await securityEvent(db, {
      subjectType: "admin",
      subjectId: admin ? admin.admin_user_id : null,
      action: "admin.login_failed",
      ip: meta.ip,
    });
    fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }
  const token = randomToken(32);
  const csrf = randomToken(24);
  const session = await db.query<{ session_id: string }>(
    `INSERT INTO admin_session(admin_user_id, token_hash, csrf_token, expires_at, ip, user_agent)
     VALUES($1,$2,$3, now() + ($4 || ' hours')::interval, $5, $6) RETURNING session_id`,
    [admin.admin_user_id, digest(token), csrf, String(config.sessions.adminHours), meta.ip ?? null, meta.userAgent ?? null],
  );
  await db.query("UPDATE admin_user SET last_login_at = now() WHERE admin_user_id = $1", [admin.admin_user_id]);
  const [roles, permissions] = await Promise.all([
    db.query<{ role_name: string }>(
      `SELECT r.role_name FROM admin_user_role ur JOIN admin_role r ON r.role_id = ur.role_id
        WHERE ur.admin_user_id = $1 ORDER BY r.role_name`,
      [admin.admin_user_id],
    ),
    db.query<{ permission_code: Permission }>(
      `SELECT DISTINCT rp.permission_code FROM admin_user_role ur
         JOIN admin_role_permission rp ON rp.role_id = ur.role_id
        WHERE ur.admin_user_id = $1 ORDER BY 1`,
      [admin.admin_user_id],
    ),
  ]);
  await securityEvent(db, {
    subjectType: "admin",
    subjectId: admin.admin_user_id,
    action: "admin.login",
    ip: meta.ip,
    metadata: { session_id: session.rows[0]!.session_id },
  });
  delete admin.password_hash;
  return {
    admin,
    token,
    csrf,
    permissions: permissions.rows.map((p) => p.permission_code),
    roles: roles.rows.map((r) => r.role_name),
  };
}

export async function revokeSession(db: Database, actor: Actor): Promise<void> {
  const table =
    actor.kind === "admin" ? "admin_session" : actor.kind === "customer" ? "customer_session" : "guest_session";
  const column = actor.kind === "admin" ? "admin_user_id" : actor.kind === "customer" ? "customer_id" : "guest_session_id";
  const value = actor.kind === "admin" ? actor.adminUserId : actor.kind === "customer" ? actor.customerId : actor.guestSessionId;
  await db.query(
    `UPDATE ${table} SET revoked_at = now() WHERE session_id = $1 AND ${column} = $2`,
    [actor.sessionId, value],
  );
  await securityEvent(db, {
    subjectType: actor.kind,
    subjectId: String(value),
    action: `${actor.kind}.logout`,
  });
}

/** Idempotent admin provisioning used by `npm run db:seed`. */
export async function provisionAdmin(
  db: Database,
  input: { email: string; password: string; displayName: string; role: string },
): Promise<{ created: boolean; adminUserId: string }> {
  const existing = await db.query<{ admin_user_id: string }>(
    "SELECT admin_user_id FROM admin_user WHERE email = $1",
    [input.email],
  );
  if (existing.rows[0]) {
    return { created: false, adminUserId: existing.rows[0].admin_user_id };
  }
  const role = await db.query<{ role_id: number }>("SELECT role_id FROM admin_role WHERE role_name = $1", [
    input.role,
  ]);
  if (!role.rows[0]) fail(422, "VALIDATION_ERROR", `Unknown role: ${input.role}`);
  const passwordHash = await hashPassword(input.password);
  return db.withTransaction(async (tx) => {
    const created = await tx.query<{ admin_user_id: string }>(
      `INSERT INTO admin_user(email, password_hash, display_name)
       VALUES($1,$2,$3) RETURNING admin_user_id`,
      [input.email, passwordHash, input.displayName],
    );
    const adminUserId = created.rows[0]!.admin_user_id;
    await tx.query("INSERT INTO admin_user_role(admin_user_id, role_id) VALUES($1,$2)", [
      adminUserId,
      role.rows[0]!.role_id,
    ]);
    return { created: true, adminUserId };
  });
}

/** Shared by admin guards: permission check with a stable error message. */
export function requireAnyPermission(actor: AdminActor, permissions: Permission[]): void {
  if (!permissions.some((permission) => actor.permissions.includes(permission))) {
    fail(403, "FORBIDDEN", `One of these permissions is required: ${permissions.join(", ")}`);
  }
}

export function requirePermission(actor: AdminActor, permission: Permission): void {
  if (!actor.permissions.includes(permission)) {
    fail(403, "FORBIDDEN", `Permission required: ${permission}`);
  }
}

/** Test helper export to keep password rules in one place. */
export const passwordInternals = { scryptParams: { ...{ N: 32_768, r: 8, p: 1 } } };
