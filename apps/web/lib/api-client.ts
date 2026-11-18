"use client";

/**
 * Browser API helper.
 *
 * Everything is same-origin (proxied by Next), so cookies are first-party.
 * Mutations carry the CSRF token issued by the API session, and callers that
 * create resources pass an Idempotency-Key so retries are safe.
 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    request_id: string;
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;

export async function loadIdentity() {
  const response = await fetch("/api/v1/auth/me", {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) return null;
  const body = await response.json();
  csrfToken = body?.data?.csrf_token ?? null;
  return body?.data as {
    authenticated: boolean;
    kind?: "customer" | "guest" | "admin";
    customer?: any;
    admin?: any;
  } | null;
}

async function ensureCsrf(): Promise<string | null> {
  if (csrfToken) return csrfToken;
  await loadIdentity();
  return csrfToken;
}

export async function api<T = any>(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    const token = await ensureCsrf();
    if (token) headers["x-csrf-token"] = token;
    if (options.idempotencyKey)
      headers["idempotency-key"] = options.idempotencyKey;
  }
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "include",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = body as ApiErrorBody;
    // A stale CSRF token (for example after a guest session was just created)
    // is refreshed once instead of surfacing a confusing 403.
    if (method !== "GET" && error?.error?.code === "CSRF_INVALID") {
      csrfToken = null;
      await loadIdentity();
      if (csrfToken) {
        return api<T>(path, { ...options, method });
      }
    }
    throw new ApiError(
      response.status,
      error?.error?.code ?? "UNKNOWN",
      error?.error?.message ?? `Request failed with status ${response.status}`,
      error?.error?.request_id,
    );
  }
  return body?.data as T;
}

export const newIdempotencyKey = () => `web-${crypto.randomUUID()}`;
