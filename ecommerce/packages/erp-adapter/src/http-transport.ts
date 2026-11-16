/**
 * HTTP transport for the ERP API.
 *
 * Responsibilities kept deliberately narrow:
 *  - session acquisition (login), cookie + CSRF retention, single-flight relogin;
 *  - Origin enforcement exactly as the ERP expects;
 *  - idempotency, bounded retries with backoff, timeouts;
 *  - translating ERP errors into typed `ErpError`s;
 *  - never logging or persisting credentials, cookies or CSRF tokens.
 */
import { createHmac } from "node:crypto";
import type { ErpTransport, ErpRequest, ErpResponse } from "./types.ts";
import { ErpError } from "./errors.ts";

export interface HttpTransportOptions {
  baseUrl: string;
  email: string;
  password: string;
  totpSecret?: string;
  /** Origin sent on mutations; must be allowlisted by the ERP. */
  origin: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
  /** Session lifetime assumed when the ERP does not report it. */
  sessionHours?: number;
}

interface Session {
  cookie: string;
  csrf: string;
  createdAt: number;
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Invalid TOTP secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s step) used only when ERP MFA is enabled. */
export function totpCode(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HttpErpTransport implements ErpTransport {
  private session: Session | null = null;
  private loginPromise: Promise<Session> | null = null;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sessionMs: number;

  constructor(private readonly options: HttpTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 6));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.sessionMs = (options.sessionHours ?? 12) * 3600_000;
  }

  /** Exposed for diagnostics only: never includes secret material. */
  get status() {
    return {
      base_url: this.options.baseUrl,
      authenticated: Boolean(this.session),
      origin: this.options.origin,
    };
  }

  private buildUrl(path: string, query?: ErpRequest["query"]): string {
    const url = new URL(this.options.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async login(): Promise<Session> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.performLogin().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  private async performLogin(): Promise<Session> {
    const body: Record<string, string> = {
      email: this.options.email,
      password: this.options.password,
    };
    if (this.options.totpSecret) body.totp = totpCode(this.options.totpSecret);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl("/api/v1/auth/login"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: this.options.origin,
          "user-agent": "duka-ecommerce-erp-adapter/0.1",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error: any) {
      if (error?.name === "AbortError") {
        throw new ErpError("ERP_TIMEOUT", "ERP login timed out", undefined, undefined, true);
      }
      throw new ErpError("ERP_UNAVAILABLE", `ERP login request failed: ${error?.message ?? "network error"}`, undefined, undefined, true);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const code = payload?.error?.code;
      if (response.status === 401) {
        throw new ErpError("ERP_AUTH_FAILED", "The ERP rejected the integration identity credentials", 401, code, false);
      }
      if (response.status === 429) {
        throw new ErpError("ERP_RATE_LIMITED", "ERP login is rate limited; back off", 429, code, true);
      }
      if (response.status === 403) {
        throw new ErpError(
          "ERP_FORBIDDEN",
          "The ERP rejected the request origin. Add the e-commerce API origin to the ERP ALLOWED_ORIGINS, or set ERP_ALLOWED_ORIGIN to the ERP web origin.",
          403,
          code,
          false,
        );
      }
      throw new ErpError(
        response.status >= 500 ? "ERP_UNAVAILABLE" : "ERP_PROTOCOL",
        `ERP login failed with status ${response.status}`,
        response.status,
        code,
        response.status >= 500,
      );
    }

    const cookies =
      typeof (response.headers as any).getSetCookie === "function" ? (response.headers as any).getSetCookie() : [];
    const rawCookie = cookies.length
      ? cookies
      : (response.headers.get("set-cookie") ?? "").split(/,(?=[^;]+=)/).filter(Boolean);
    const sessionCookie = rawCookie
      .map((entry: string) => entry.split(";")[0]!.trim())
      .find((entry: string) => entry.startsWith("duka_session="));
    if (!sessionCookie) {
      throw new ErpError("ERP_PROTOCOL", "ERP login succeeded but returned no duka_session cookie");
    }
    const csrf = payload?.data?.csrf_token;
    if (typeof csrf !== "string" || csrf.length < 10) {
      throw new ErpError("ERP_PROTOCOL", "ERP login succeeded but returned no CSRF token");
    }

    const session: Session = { cookie: sessionCookie, csrf, createdAt: Date.now() };
    this.session = session;
    return session;
  }

  private async activeSession(force = false): Promise<Session> {
    if (force) this.session = null;
    const current = this.session;
    if (current && Date.now() - current.createdAt < this.sessionMs - 5 * 60_000) return current;
    return this.login();
  }

  async request<T = unknown>(request: ErpRequest): Promise<ErpResponse<T>> {
    let attempt = 0;
    let relogged = false;

    for (;;) {
      attempt += 1;
      const session = await this.activeSession();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const headers: Record<string, string> = {
        accept: "application/json",
        cookie: session.cookie,
        origin: this.options.origin,
        "user-agent": "duka-ecommerce-erp-adapter/0.1",
      };
      if (request.method !== "GET") {
        headers["content-type"] = "application/json";
        headers["x-csrf-token"] = session.csrf;
      }
      if (request.idempotencyKey) headers["idempotency-key"] = request.idempotencyKey;
      if (request.requestId) headers["x-request-id"] = request.requestId;

      let response: Response;
      try {
        response = await this.fetchImpl(this.buildUrl(request.path, request.query), {
          method: request.method,
          headers,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal: controller.signal,
        });
      } catch (error: any) {
        clearTimeout(timer);
        const timedOut = error?.name === "AbortError";
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new ErpError(
          timedOut ? "ERP_TIMEOUT" : "ERP_UNAVAILABLE",
          timedOut
            ? `ERP ${request.method} ${request.path} timed out`
            : `ERP ${request.method} ${request.path} failed: ${error?.message ?? "network error"}`,
          undefined,
          undefined,
          true,
        );
      }
      clearTimeout(timer);

      const text = await response.text();
      let payload: any = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          if (response.ok) {
            throw new ErpError("ERP_PROTOCOL", "ERP returned a non-JSON success body", response.status);
          }
        }
      }

      if (response.ok) {
        return {
          status: response.status,
          data: (payload?.data ?? null) as T,
          requestId: payload?.meta?.request_id ?? response.headers.get("x-request-id") ?? "",
        };
      }

      const erpCode = payload?.error?.code as string | undefined;
      const message = payload?.error?.message as string | undefined;

      if (response.status === 401 && !relogged) {
        relogged = true;
        this.session = null;
        this.options.logger?.warn({ path: request.path }, "ERP session rejected; re-authenticating once");
        continue;
      }

      const retryable =
        response.status === 429 ||
        response.status >= 500 ||
        ["TRANSACTION_BUSY", "QUERY_TIMEOUT"].includes(erpCode ?? "");

      if (retryable && attempt < this.maxAttempts) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "");
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : this.backoff(attempt));
        continue;
      }

      throw this.toError(response.status, erpCode, message, payload?.error?.details);
    }
  }

  private backoff(attempt: number): number {
    return Math.min(250 * 2 ** (attempt - 1), 4_000) + Math.floor(Math.random() * 100);
  }

  private toError(status: number, erpCode?: string, message?: string, details?: unknown): ErpError {
    const suffix = erpCode ? ` (${erpCode})` : "";
    switch (status) {
      case 400:
      case 422:
        return new ErpError("ERP_VALIDATION", `ERP rejected the payload${suffix}: ${message ?? "validation error"}`, status, erpCode, false, details);
      case 401:
        return new ErpError("ERP_AUTH_FAILED", "ERP authentication failed", status, erpCode);
      case 403:
        return new ErpError(
          "ERP_FORBIDDEN",
          `ERP denied the operation${suffix}: ${message ?? "permission, scope, CSRF or origin"}`,
          status,
          erpCode,
        );
      case 404:
        return new ErpError("ERP_NOT_FOUND", `ERP resource not found${suffix}`, status, erpCode);
      case 409:
        return new ErpError("ERP_CONFLICT", `ERP state conflict${suffix}: ${message ?? "conflict"}`, status, erpCode, false, details);
      case 429:
        return new ErpError("ERP_RATE_LIMITED", "ERP rate limit reached", status, erpCode, true);
      default:
        return new ErpError(
          status >= 500 ? "ERP_UNAVAILABLE" : "ERP_PROTOCOL",
          `ERP request failed with status ${status}${suffix}`,
          status,
          erpCode,
          status >= 500,
          details,
        );
    }
  }

  async health(): Promise<{ ok: boolean; live: boolean; ready: boolean; detail?: unknown }> {
    const probe = async (path: string) => {
      try {
        const response = await this.fetchImpl(this.buildUrl(path), {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
        });
        return response.ok;
      } catch {
        return false;
      }
    };
    const [live, ready] = await Promise.all([probe("/health/live"), probe("/health/ready")]);
    return { ok: live && ready, live, ready };
  }

  async close(): Promise<void> {
    this.session = null;
  }
}
