/**
 * Password hashing, token generation, rate limiting and audit helpers.
 *
 * Hashing uses scrypt from Node's standard library (no native build step):
 * N=2^15, r=8, p=1, 64-byte digest, 16-byte random salt, stored with its
 * parameters so a future upgrade can re-hash on next login.
 */
import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { fail } from "../errors.ts";
import type { Database, Queryable } from "../db/index.ts";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const SCRYPT = { N: 32_768, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) {
    fail(422, "VALIDATION_ERROR", "Password must be 12–256 characters");
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    fail(422, "VALIDATION_ERROR", "Password must include letters and numbers");
  }
  const salt = randomBytes(16);
  const derived = await scrypt(
    password.normalize("NFKC"),
    salt,
    SCRYPT.keylen,
    {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: 64 * 1024 * 1024,
    },
  );
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  encoded: string,
  password: string,
): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, expected] = parts;
  const derived = await scrypt(
    password.normalize("NFKC"),
    Buffer.from(salt!, "base64url"),
    SCRYPT.keylen,
    {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    },
  );
  const expectedBuffer = Buffer.from(expected!, "base64url");
  return (
    derived.length === expectedBuffer.length &&
    timingSafeEqual(derived, expectedBuffer)
  );
}

/** Fixed dummy hash so failed logins cost the same as successful ones. */
let dummyHash: string | undefined;
export async function verifyDummyPassword(password: string): Promise<void> {
  dummyHash ??= await hashPassword("dummy-password-for-timing-1");
  await verifyPassword(dummyHash, password).catch(() => false);
}

export const randomToken = (bytes = 32) =>
  randomBytes(bytes).toString("base64url");
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Rate limit buckets are keyed by a digest, never by a raw email or IP. */
export async function rateLimit(
  db: Database | Queryable,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<void> {
  const result = await db.query<{ hits: number }>(
    `INSERT INTO rate_limit_bucket(bucket_key, window_start, hits)
     VALUES($1, now(), 1)
     ON CONFLICT (bucket_key) DO UPDATE SET
       hits = CASE WHEN rate_limit_bucket.window_start < now() - ($2::text || ' seconds')::interval
                   THEN 1 ELSE rate_limit_bucket.hits + 1 END,
       window_start = CASE WHEN rate_limit_bucket.window_start < now() - ($2::text || ' seconds')::interval
                   THEN now() ELSE rate_limit_bucket.window_start END
     RETURNING hits`,
    [sha256(key), String(windowSeconds)],
  );
  if ((result.rows[0]?.hits ?? 0) > max) {
    fail(429, "RATE_LIMITED", "Too many attempts. Please try again later");
  }
}

export async function securityEvent(
  db: Database | Queryable,
  event: {
    subjectType: "customer" | "guest" | "admin";
    subjectId?: string | null;
    action: string;
    ip?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    "INSERT INTO security_event(subject_type, subject_id, action, ip, metadata) VALUES($1,$2,$3,$4,$5)",
    [
      event.subjectType,
      event.subjectId ?? null,
      event.action,
      event.ip ?? null,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}

export async function audit(
  db: Database | Queryable,
  entry: {
    actorType: "customer" | "guest" | "admin" | "system";
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | number | null;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
    requestId?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log(actor_type, actor_id, action, entity_type, entity_id, before, after, ip, request_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId === undefined || entry.entityId === null
        ? null
        : String(entry.entityId),
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.ip ?? null,
      entry.requestId ?? null,
    ],
  );
}

/** Redact values that must never reach audit rows, logs or sync payloads. */
export function redact<T>(value: T): T {
  const secretKeys = new Set([
    "password",
    "password_hash",
    "token",
    "token_hash",
    "csrf",
    "csrf_token",
    "secret",
    "provider_token",
    "consumer_secret",
    "passkey",
    "authorization",
    "cookie",
  ]);
  const walk = (input: any): any => {
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input).map(([key, val]) => [
          key,
          secretKeys.has(key.toLowerCase()) ? "[redacted]" : walk(val),
        ]),
      );
    }
    return input;
  };
  return walk(value);
}
