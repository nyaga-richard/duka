/**
 * Generates docs/API.md from the live route registry.
 *
 * The registry is filled by the same `endpoint()` calls the server uses at
 * runtime, so the document cannot drift from the code.
 */
import { writeFile } from "node:fs/promises";
import { createApiRouter } from "../apps/api/src/routes/index.ts";
import { routeRegistry } from "../apps/api/src/http/route.ts";

const AUTH_LABEL: Record<string, string> = {
  public: "public",
  customer: "customer session",
  customer_or_guest: "customer or guest session",
  admin: "administrator session",
  any: "any signed-in identity",
};

createApiRouter();

const rows = routeRegistry
  .slice()
  .sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );

const lines: string[] = [];
lines.push("# API reference");
lines.push("");
lines.push(
  "Generated from the runtime route registry by `npx tsx scripts/api-docs.ts`.",
);
lines.push("Do not edit by hand.");
lines.push("");
lines.push(
  `**${rows.length} endpoints.** Base path \`/api/v1\`. Interactive docs: \`GET /api/v1/docs\`, machine readable: \`GET /api/v1/openapi.json\`.`,
);
lines.push("");
lines.push("## Conventions");
lines.push("");
lines.push('- Success: `{ "data": …, "meta": { "request_id": "…" } }`.');
lines.push(
  '- Errors: `{ "error": { "code", "message", "details?", "request_id" } }`; quote the request id in support.',
);
lines.push(
  "- Every state-changing request needs an `Origin` header from the allowlist **and** the `X-CSRF-Token` returned when the session was created (`/auth/me` returns the current token).",
);
lines.push(
  "- `Idempotency-Key` is mandatory where marked; reusing a key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.",
);
lines.push(
  "- Provider webhooks are exempt from CSRF/Origin and are authenticated by HMAC instead.",
);
lines.push(
  "- `GET /api/v1/catalog/images/:attachmentId` is the one binary response: raw image bytes, `cache-control: public, max-age=600`, and a 1×1 transparent PNG with `no-store` when the ERP cannot be reached.",
);
lines.push("");
lines.push("| Method | Path | Auth | Permissions | Idempotent | Description |");
lines.push("| --- | --- | --- | --- | --- | --- |");
for (const route of rows) {
  lines.push(
    `| ${route.method.toUpperCase()} | \`${route.path}\` | ${AUTH_LABEL[route.auth] ?? route.auth} | ${
      route.permissions.length
        ? route.permissions.map((permission) => `\`${permission}\``).join(", ")
        : "—"
    } | ${route.idempotent ? "required" : "—"} | ${route.summary} |`,
  );
}

lines.push("");
lines.push("## Error codes");
lines.push("");
lines.push("| Code | Meaning |");
lines.push("| --- | --- |");
const codes: Array<[string, string]> = [
  ["VALIDATION_ERROR", "Payload or query failed schema validation (422)."],
  ["UNAUTHENTICATED", "No session for the required realm (401)."],
  [
    "INVALID_CREDENTIALS",
    "Wrong email/password (401); the message never reveals which.",
  ],
  ["EMAIL_TAKEN", "Registration for an existing customer email (409)."],
  [
    "FORBIDDEN",
    "Authenticated but not allowed (403): permission, realm or ownership.",
  ],
  [
    "CSRF_INVALID",
    "Missing or stale X-CSRF-Token (403); fetch /auth/me for the current token.",
  ],
  ["ORIGIN_DENIED", "Origin missing or not in the allowlist (403)."],
  [
    "NOT_FOUND",
    "Unknown resource, or a resource the caller must not learn about (404).",
  ],
  ["CONFLICT", "State conflict (409)."],
  ["IDEMPOTENCY_REQUIRED", "Operation needs an Idempotency-Key header (422)."],
  ["IDEMPOTENCY_KEY_REUSED", "Same key, different payload (409)."],
  ["IDEMPOTENCY_IN_PROGRESS", "Identical request still running (409)."],
  [
    "INSUFFICIENT_STOCK",
    "Not enough unreserved stock (409, with availability details).",
  ],
  ["EMPTY_CART", "Checkout with nothing in the cart (422)."],
  [
    "CART_RESERVATION_EXPIRED",
    "Holds expired before checkout completed (409).",
  ],
  [
    "INVALID_STATE_TRANSITION",
    "Order/shipment/refund does not allow that move (409).",
  ],
  ["PAYMENTS_DISABLED", "Payment capture is switched off (503)."],
  ["PROVIDER_UNAVAILABLE", "Payment provider unreachable (502)."],
  ["ERP_UNAVAILABLE", "ERP unreachable after retries (502)."],
  [
    "ERP_CONTRACT_UNSUPPORTED",
    "The ERP does not expose the needed capability (501); see docs/ERP_INTEGRATION_CONTRACT.md.",
  ],
  ["RATE_LIMITED", "Too many attempts (429)."],
  ["PAYLOAD_TOO_LARGE", "Body over 256 kb (413)."],
  ["INVALID_JSON", "Malformed JSON body (400)."],
  ["DEPENDENCY_NOT_READY", "Database or migrations not ready (503)."],
  ["INTERNAL_ERROR", "Unexpected failure (500); details stay in logs."],
];
for (const [code, meaning] of codes) lines.push(`| \`${code}\` | ${meaning} |`);

lines.push("");
lines.push("## Identity realms");
lines.push("");
lines.push("| Realm | Cookie | Created by | Notes |");
lines.push("| --- | --- | --- | --- |");
lines.push(
  "| Customer | `ecom_session` | `POST /auth/register`, `POST /auth/login` | Email + password (scrypt). |",
);
lines.push(
  "| Guest | `ecom_guest` | `POST /auth/guest`, or automatically on the first cart write | Optional email; required before guest checkout. |",
);
lines.push(
  "| Administrator | `ecom_admin_session` | `POST /admin/auth/login` | Separate table, roles and permissions; never shares a customer identity. |",
);
lines.push("");
lines.push(
  "Sessions are opaque random tokens stored only as SHA-256 digests, `HttpOnly`, `SameSite=Lax`, and revoked on logout and password change.",
);

await writeFile("docs/API.md", `${lines.join("\n")}\n`);
console.log(`Wrote docs/API.md with ${rows.length} endpoints`);
