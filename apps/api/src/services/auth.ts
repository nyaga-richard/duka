import argon2 from "argon2";
import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { parse, serialize } from "cookie";
import type { Request, Response, NextFunction } from "express";
import nodemailer from "nodemailer";
import {
  pool,
  digest,
  fail,
  transaction,
  audit,
  one,
  type Actor,
  type Context,
} from "../db.ts";
export const SESSION_COOKIE = "duka_session";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes: Buffer) {
  let bits = 0,
    value = 0,
    out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(text: string) {
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const n = alphabet.indexOf(ch);
    if (n < 0) throw new Error("Invalid TOTP key");
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totp(secret: string, step = Math.floor(Date.now() / 30000)) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", unbase32(secret)).update(b).digest();
  const offset = h[h.length - 1] & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
const encryptionKey = () => {
  if (process.env.NODE_ENV === "production" && !process.env.MFA_ENCRYPTION_KEY)
    throw new Error("MFA_ENCRYPTION_KEY required");
  return createHash("sha256")
    .update(
      process.env.MFA_ENCRYPTION_KEY ??
        process.env.DATABASE_URL ??
        "development-only",
    )
    .digest();
};
function encrypt(text: string) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const b = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), b].map((v) => v.toString("base64url")).join(".");
}
function decrypt(text: string) {
  const [iv, tag, data] = text
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const c = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  c.setAuthTag(tag);
  return Buffer.concat([c.update(data), c.final()]).toString("utf8");
}
export function verifyTotp(
  secret: string,
  code: string,
  lastStep?: string | number | null,
) {
  if (!/^\d{6}$/.test(code)) return null;
  for (let n = -1; n <= 1; n++) {
    const step = Math.floor(Date.now() / 30000) + n;
    if (lastStep != null && step <= Number(lastStep)) continue;
    const expected = totp(secret, step);
    if (
      code.length === 6 &&
      timingSafeEqual(Buffer.from(code), Buffer.from(expected))
    )
      return step;
  }
  return null;
}
export function validPassword(password: string) {
  if (
    password.length < 12 ||
    password.length > 256 ||
    !/[a-z]/i.test(password) ||
    !/[0-9]/.test(password)
  )
    fail(
      422,
      "WEAK_PASSWORD",
      "Use 12–256 characters, including letters and numbers",
    );
}
export async function rateLimit(key: string, max: number, seconds: number) {
  const result = await pool.query(
    "INSERT INTO rate_limit_buckets(key,window_start,hits) VALUES($1,now(),1) ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_limit_buckets.window_start < now()-($2||' seconds')::interval THEN 1 ELSE rate_limit_buckets.hits+1 END,window_start=CASE WHEN rate_limit_buckets.window_start < now()-($2||' seconds')::interval THEN now() ELSE rate_limit_buckets.window_start END RETURNING hits",
    [digest(key), seconds],
  );
  if (result.rows[0].hits > max)
    fail(429, "RATE_LIMITED", "Too many attempts. Try again later");
}
export async function securityEvent(
  action: string,
  userId: string | null,
  ip: string | undefined,
  companyId: string | null = null,
  metadata: unknown = {},
) {
  await pool.query(
    "INSERT INTO security_events(company_id,user_id,action,ip,metadata) VALUES($1,$2,$3,$4,$5)",
    [companyId, userId, action, ip ?? null, JSON.stringify(metadata)],
  );
}
// Workspace embedding is an explicit isolated-demo transport mode, never a
// production relaxation. CHIPS partitions this HttpOnly cookie by top-level site.
export const workspacePreviewEnabled = () =>
  process.env.WORKSPACE_PREVIEW === "true" &&
  process.env.DEMO_MODE === "true" &&
  process.env.NODE_ENV !== "production";
const sessionCookieName = () =>
  workspacePreviewEnabled() ? "duka_workspace_session" : SESSION_COOKIE;
function sessionCookieOptions() {
  const preview = workspacePreviewEnabled();
  return {
    httpOnly: true,
    secure: preview || process.env.COOKIE_SECURE === "true",
    sameSite: preview ? ("none" as const) : ("lax" as const),
    partitioned: preview,
    path: "/",
  };
}
export function setSessionCookie(res: Response, token: string) {
  res.setHeader(
    "Set-Cookie",
    serialize(sessionCookieName(), token, {
      ...sessionCookieOptions(),
      maxAge: Number(process.env.SESSION_HOURS ?? 12) * 3600,
    }),
  );
}
export function clearSessionCookie(res: Response) {
  res.setHeader(
    "Set-Cookie",
    serialize(sessionCookieName(), "", {
      ...sessionCookieOptions(),
      maxAge: 0,
    }),
  );
}
const dummy = argon2.hash("invalid-login-work-factor-only-9213", {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 3,
  parallelism: 1,
});
export async function login(
  input: { email: string; password: string; totp?: string },
  ip: string | undefined,
  agent: string | undefined,
) {
  await rateLimit(`login:ip:${ip}`, 30, 900);
  await rateLimit(`login:email:${input.email}`, 10, 900);
  const u = (
    await pool.query("SELECT * FROM identities WHERE email=$1", [input.email])
  ).rows[0];
  const match = await argon2.verify(
    u?.password_hash ?? (await dummy),
    input.password,
  );
  if (!u || !match || u.status !== "active") {
    await securityEvent(
      "login.failed",
      u?.id ?? null,
      ip,
      u?.company_id ?? null,
    );
    fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const user = (
      await db.query("SELECT * FROM identities WHERE id=$1 FOR UPDATE", [u.id])
    ).rows[0];
    if (
      user.status !== "active" ||
      (user.password_hash !== u.password_hash &&
        !(await argon2.verify(user.password_hash, input.password)))
    )
      fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
    if (user.mfa_enabled) {
      if (!input.totp)
        fail(401, "MFA_REQUIRED", "Enter your six-digit authenticator code");
      const step = verifyTotp(
        decrypt(user.mfa_secret),
        input.totp,
        user.last_totp_step,
      );
      if (step === null)
        fail(401, "INVALID_MFA", "Invalid or already used authenticator code");
      await db.query("UPDATE identities SET last_totp_step=$1 WHERE id=$2", [
        step,
        user.id,
      ]);
    }
    const token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(24).toString("base64url");
    await db.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at,ip,user_agent) VALUES($1,$2,$3,now()+($4||' hours')::interval,$5,$6)",
      [
        user.id,
        digest(token),
        csrf,
        Number(process.env.SESSION_HOURS ?? 12),
        ip ?? null,
        agent?.slice(0, 500) ?? null,
      ],
    );
    await db.query("COMMIT");
    await securityEvent("login.success", user.id, ip, user.company_id);
    return { token, csrf };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function actorFromToken(token: string): Promise<Actor> {
  const r = await pool.query(
    "SELECT u.id,u.company_id,u.email,u.name,s.id AS session_id,s.csrf_token FROM sessions s JOIN identities u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active'",
    [digest(token)],
  );
  const u = r.rows[0];
  if (!u) fail(401, "UNAUTHENTICATED", "Your session expired. Please sign in");
  const actor: Actor = {
    ...u,
    permissions: [],
    branch_ids: [],
    warehouse_ids: [],
    approval_limit: "0",
  };
  return transaction(actor, async (ctx) => {
    const roles = await ctx.db.query(
      "SELECT DISTINCT rp.permission FROM user_roles ur JOIN role_permissions rp ON rp.company_id=ur.company_id AND rp.role_id=ur.role_id WHERE ur.company_id=$1 AND ur.user_id=$2",
      [u.company_id, u.id],
    );
    actor.permissions = roles.rows.map((p) => p.permission);
    actor.approval_limit = (
      await ctx.db.query(
        "SELECT coalesce(max(r.approval_limit),0)::text AS n FROM user_roles ur JOIN roles r ON r.company_id=ur.company_id AND r.id=ur.role_id WHERE ur.company_id=$1 AND ur.user_id=$2",
        [u.company_id, u.id],
      )
    ).rows[0].n;
    actor.branch_ids = (
      await ctx.db.query(
        "SELECT branch_id FROM user_branches WHERE company_id=$1 AND user_id=$2",
        [u.company_id, u.id],
      )
    ).rows.map((r) => r.branch_id);
    actor.warehouse_ids = (
      await ctx.db.query(
        "SELECT warehouse_id FROM user_warehouses WHERE company_id=$1 AND user_id=$2",
        [u.company_id, u.id],
      )
    ).rows.map((r) => r.warehouse_id);
    return actor;
  });
}
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const token = parse(req.headers.cookie ?? "")[sessionCookieName()];
    if (!token) fail(401, "UNAUTHENTICATED", "Please sign in");
    (req as any).actor = await actorFromToken(token);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const a = (req as any).actor as Actor;
      const csrf = req.header("X-CSRF-Token") ?? "";
      if (
        Buffer.byteLength(csrf) !== Buffer.byteLength(a.csrf_token!) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(a.csrf_token!))
      )
        fail(403, "CSRF_INVALID", "Security token is missing or invalid");
    }
    next();
  } catch (e) {
    next(e);
  }
}
export async function logout(actor: Actor) {
  await pool.query(
    "UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2",
    [actor.session_id, actor.id],
  );
  await securityEvent("logout", actor.id, undefined, actor.company_id);
}
export async function sendMail(
  to: string,
  subject: string,
  body: string,
  messageId?: string,
) {
  if (process.env.MAIL_MODE === "smtp") {
    if (!process.env.SMTP_URL)
      fail(
        503,
        "MAIL_UNCONFIGURED",
        "Password reset delivery is not configured",
      );
    const url = new URL(process.env.SMTP_URL);
    if (!["smtp:", "smtps:"].includes(url.protocol))
      fail(503, "MAIL_UNCONFIGURED", "Use an SMTP or SMTPS connection URL");
    const production = process.env.NODE_ENV === "production";
    const transport = nodemailer.createTransport({
      host: url.hostname,
      port: Number(url.port || (url.protocol === "smtps:" ? 465 : 587)),
      secure: url.protocol === "smtps:",
      requireTLS: production,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      ...(url.username
        ? {
            auth: {
              user: decodeURIComponent(url.username),
              pass: decodeURIComponent(url.password),
            },
          }
        : {}),
      tls: { rejectUnauthorized: true },
    });
    await transport.sendMail({
      from: process.env.MAIL_FROM ?? "no-reply@localhost",
      to,
      subject,
      text: body,
      ...(messageId ? { messageId } : {}),
    });
  } else {
    if (process.env.NODE_ENV === "production")
      fail(503, "MAIL_UNCONFIGURED", "Configure SMTP in production");
    await pool.query(
      "INSERT INTO mail_outbox(recipient,subject,body) VALUES($1,$2,$3)",
      [to, subject, body],
    );
  }
}
export async function requestReset(email: string, ip: string | undefined) {
  const started = Date.now();
  try {
    await rateLimit(`reset:${ip}`, 5, 900);
    const u = (
      await pool.query(
        "SELECT id,company_id FROM identities WHERE email=$1 AND status='active'",
        [email],
      )
    ).rows[0];
    if (!u) return;
    if (
      process.env.NODE_ENV === "production" &&
      process.env.MAIL_MODE !== "smtp"
    )
      fail(503, "MAIL_UNCONFIGURED", "Configure SMTP in production");
    const token = randomBytes(32).toString("base64url"),
      base = process.env.WEB_ORIGIN ?? "http://localhost:3000",
      db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')",
        [digest(token), u.id],
      );
      await db.query(
        "INSERT INTO mail_outbox(recipient,subject,body,delivery_mode) VALUES($1,$2,$3,$4)",
        [
          email,
          "Reset your Duka password",
          `Reset your password within 30 minutes: ${base}/reset-password?token=${encodeURIComponent(token)}\nIf you did not request this, ignore this message.`,
          process.env.MAIL_MODE === "smtp" ? "smtp" : "outbox",
        ],
      );
      await db.query(
        "INSERT INTO security_events(company_id,user_id,action,ip) VALUES($1,$2,'password.reset_requested',$3)",
        [u.company_id, u.id, ip ?? null],
      );
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  } finally {
    await new Promise((r) =>
      setTimeout(r, Math.max(0, 300 - Date.now() + started) + randomInt(0, 80)),
    );
  }
}
export async function processMailJob(id: string) {
  if (process.env.MAIL_MODE !== "smtp") return false;
  const db = await pool.connect(),
    lease = randomUUID();
  let job: any;
  try {
    await db.query("BEGIN");
    job = (
      await db.query(
        "SELECT * FROM mail_outbox WHERE id=$1 AND delivery_mode='smtp' AND status IN ('pending','processing') AND next_attempt_at<=now() AND expires_at>now() AND attempts<10 FOR UPDATE SKIP LOCKED",
        [id],
      )
    ).rows[0];
    if (job)
      await db.query(
        "UPDATE mail_outbox SET status='processing',attempts=attempts+1,lease_token=$1,next_attempt_at=now()+interval '2 minutes' WHERE id=$2",
        [lease, id],
      );
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
  if (!job) return false;
  try {
    await sendMail(
      job.recipient,
      job.subject,
      job.body,
      `<${job.id}@duka.local>`,
    );
    await pool.query(
      "UPDATE mail_outbox SET status='sent',sent_at=now(),body='',lease_token=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2",
      [id, lease],
    );
    return true;
  } catch (e: any) {
    await pool.query(
      "UPDATE mail_outbox SET status=CASE WHEN attempts>=10 THEN 'failed' ELSE 'pending' END,body=CASE WHEN attempts>=10 THEN '' ELSE body END,last_error=$1,lease_token=NULL,next_attempt_at=now()+make_interval(secs=>least(600,5*power(2,attempts)::int)) WHERE id=$2 AND lease_token=$3",
      [String(e.code ?? "SMTP_DELIVERY_FAILED").slice(0, 100), id, lease],
    );
    return false;
  }
}
export async function resetPassword(token: string, password: string) {
  validPassword(password);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const lookup = (
      await db.query(
        "SELECT user_id FROM password_resets WHERE token_hash=$1",
        [digest(token)],
      )
    ).rows[0];
    if (!lookup)
      fail(400, "INVALID_RESET", "This reset link is invalid or expired");
    const identity = (
      await db.query(
        "SELECT id,company_id FROM identities WHERE id=$1 FOR UPDATE",
        [lookup.user_id],
      )
    ).rows[0];
    if (!identity)
      fail(400, "INVALID_RESET", "This reset link is invalid or expired");
    const r = await db.query(
      "SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE",
      [digest(token)],
    );
    if (!r.rowCount)
      fail(400, "INVALID_RESET", "This reset link is invalid or expired");
    const u = r.rows[0];
    const hash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 3,
      parallelism: 1,
    });
    await db.query("UPDATE identities SET password_hash=$1 WHERE id=$2", [
      hash,
      u.user_id,
    ]);
    await db.query(
      "UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",
      [u.user_id],
    );
    await db.query(
      "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
      [u.user_id],
    );
    await db.query("COMMIT");
    await securityEvent(
      "password.reset_completed",
      u.user_id,
      undefined,
      identity.company_id,
    );
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function changePassword(
  ctx: Context,
  current: string,
  next: string,
) {
  validPassword(next);
  await rateLimit("password-change:" + ctx.actor.id, 10, 900);
  const u = await one(
    ctx,
    "SELECT password_hash FROM identities WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, ctx.actor.id],
  );
  if (!(await argon2.verify(u.password_hash, current)))
    fail(403, "INVALID_PASSWORD", "Current password is incorrect");
  const hash = await argon2.hash(next, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 3,
    parallelism: 1,
  });
  await ctx.db.query(
    "UPDATE identities SET password_hash=$1 WHERE company_id=$2 AND id=$3",
    [hash, ctx.companyId, ctx.actor.id],
  );
  await ctx.db.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [
    ctx.actor.id,
  ]);
  await audit(ctx, "password.change", "user", ctx.actor.id);
}
export async function setupMfa(ctx: Context, password: string) {
  await rateLimit("mfa-security:" + ctx.actor.id, 10, 900);
  const u = await one(
    ctx,
    "SELECT * FROM identities WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, ctx.actor.id],
  );
  if (!(await argon2.verify(u.password_hash, password)))
    fail(403, "INVALID_PASSWORD", "Password is incorrect");
  if (u.mfa_enabled) fail(409, "MFA_ENABLED", "MFA is already enabled");
  const secret = base32(randomBytes(20));
  await ctx.db.query(
    "UPDATE identities SET mfa_secret=$1,mfa_setup_expires_at=now()+interval '15 minutes' WHERE company_id=$2 AND id=$3",
    [encrypt(secret), ctx.companyId, ctx.actor.id],
  );
  await audit(ctx, "mfa.setup", "user", ctx.actor.id);
  return {
    secret,
    uri: `otpauth://totp/Duka:${encodeURIComponent(u.email)}?secret=${secret}&issuer=Duka&algorithm=SHA1&digits=6&period=30`,
  };
}
export async function enableMfa(ctx: Context, code: string) {
  await rateLimit("mfa-security:" + ctx.actor.id, 10, 900);
  const u = await one(
    ctx,
    "SELECT * FROM identities WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, ctx.actor.id],
  );
  if (u.mfa_enabled) fail(409, "MFA_ENABLED", "MFA is already enabled");
  if (
    !u.mfa_secret ||
    !u.mfa_setup_expires_at ||
    new Date(u.mfa_setup_expires_at).getTime() < Date.now()
  )
    fail(
      409,
      "MFA_NOT_SETUP",
      "Provisioning expired or missing. Set up MFA again with your password",
    );
  const step = verifyTotp(decrypt(u.mfa_secret), code, u.last_totp_step);
  if (step === null) fail(422, "INVALID_MFA", "Invalid or already used code");
  await ctx.db.query(
    "UPDATE identities SET mfa_enabled=true,last_totp_step=$1,mfa_setup_expires_at=NULL WHERE company_id=$2 AND id=$3",
    [step, ctx.companyId, ctx.actor.id],
  );
  await ctx.db.query(
    "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id IS DISTINCT FROM $2::uuid AND revoked_at IS NULL",
    [ctx.actor.id, ctx.actor.session_id ?? null],
  );
  await audit(ctx, "mfa.enable", "user", ctx.actor.id);
}
export async function disableMfa(ctx: Context, password: string, code: string) {
  await rateLimit("mfa-security:" + ctx.actor.id, 10, 900);
  const u = await one(
    ctx,
    "SELECT * FROM identities WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [ctx.companyId, ctx.actor.id],
  );
  if (
    !(await argon2.verify(u.password_hash, password)) ||
    !u.mfa_secret ||
    verifyTotp(decrypt(u.mfa_secret), code, u.last_totp_step) === null
  )
    fail(
      403,
      "INVALID_CREDENTIALS",
      "Password or authenticator code is incorrect",
    );
  await ctx.db.query(
    "UPDATE identities SET mfa_enabled=false,mfa_secret=NULL,last_totp_step=NULL,mfa_setup_expires_at=NULL WHERE company_id=$1 AND id=$2",
    [ctx.companyId, ctx.actor.id],
  );
  await audit(ctx, "mfa.disable", "user", ctx.actor.id);
}
