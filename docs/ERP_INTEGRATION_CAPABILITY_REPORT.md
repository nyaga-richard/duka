# ERP Integration Capability Report

**Project:** Duka e-commerce — Phase 1 (foundation)
**ERP inspected:** `nyaga-richard/duka` at commit `38e378c397afbf547771df59dd52649a65b0cf14` (`main`)
**Date of inspection:** 16 November 2026
**Method:** direct source inspection of the checked-out ERP repository. See [Evidence](#12-evidence-and-limitations)
for exactly what was and was not available.

> This report answers the ten inspection questions in the Phase 1 brief. Nothing below is
> assumed: every reused route, table and permission is cited to a file and line in the ERP
> source. Where a capability does not exist, it is listed as a **gap** with a proposed
> contract in [`ERP_INTEGRATION_CONTRACT.md`](./ERP_INTEGRATION_CONTRACT.md).
>
> **No ERP file was modified.** The e-commerce project is additive and independent.

---

## 0. Executive summary

| Question                                      | Verdict                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can the ERP be integrated over HTTP only?     | **Yes.** It exposes a versioned JSON API under `/api/v1`; the e-commerce adapter never touches ERP PostgreSQL.                                                                                                                                          |
| Is there machine-to-machine authentication?   | **No.** Authentication is a browser session cookie + CSRF + `Origin` allowlist. The adapter needs a **dedicated ERP identity** and must behave like a browser session (see §2, §13).                                                                    |
| Are products/variants reusable?               | **Partially.** Products exist; "variants" are self-referencing child products (`products.parent_id`). No option/attribute matrix, no variant images, no public image URLs.                                                                              |
| Is stock readable?                            | **Yes** — `GET /api/v1/inventory/balances` exposes `quantity`, `reserved` and `available` per product/warehouse.                                                                                                                                        |
| Can stock be reserved for an e-commerce cart? | **Not directly.** Reservations only exist as a side effect of approving a `sales_order` **document**, with no TTL and an approval-limit/self-approval gate.                                                                                             |
| Are customers reusable?                       | **Yes** — `GET/POST /api/v1/customers`, `PUT /api/v1/customers/:id`, statements and open items.                                                                                                                                                         |
| Can an order be posted from the storefront?   | **Not as-is.** `POST /api/v1/sales` requires an active register **and an open shift owned by the calling identity**, plus a tender that balances the sale.                                                                                              |
| Are accounting/payment postings reusable?     | **Yes, for recording**: sales post balanced journals; settlements/refunds exist with their own permission gates. Payment _initiation_ is M-Pesa-only.                                                                                                   |
| Can we rely on ERP events/webhooks?           | **No.** The ERP emits no outbound webhooks. The e-commerce side must poll or use its own worker.                                                                                                                                                        |
| Net result                                    | A realistic Phase 1 integration is **catalogue + stock read**, **customer mapping**, and **order/payment mirroring through the documented endpoints**, with reservations owned locally and a short, explicit list of ERP changes requested for Phase 2. |

---

## 1. What the ERP is (verified)

| Area           | Finding                                                                                            | Evidence                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Frontend       | Next.js `16.4.2`, React `19.3.1`, one catch-all route                                              | `package.json`, `apps/web/app/[[...route]]/page.tsx`                                   |
| Backend        | Express `5.3.0` on Node ≥ 22.9, TypeScript, ESM                                                    | `package.json`, `apps/api/src/index.ts`                                                |
| Database       | PostgreSQL 17 with explicit SQL migrations, RLS-aware runtime role                                 | `database/migrations/001…029`, `apps/api/src/readiness.ts`                             |
| API base       | `/api/v1`, single router                                                                           | `apps/api/src/app.ts:198`, `apps/api/src/http.ts`                                      |
| Response shape | `{ data, meta: { request_id } }`; errors `{ error: { code, message, details?, request_id } }`      | `apps/api/src/app.ts:202-268`, `apps/api/src/http.ts`                                  |
| Auth           | Server-side sessions, cookie `duka_session`, CSRF header, argon2id, optional TOTP                  | `apps/api/src/services/auth.ts:186,259,300`                                            |
| Authorisation  | Permission strings on roles, checked per endpoint; branch/warehouse scoping                        | `apps/api/src/db.ts:143`, `apps/api/src/http.ts:88`                                    |
| Ops            | Docker Compose behind Caddy + Cloudflare Tunnel; **only 80/443 published**, DB and API are private | `../duka/deploy/docker/compose.yml:88`, `../duka/deploy/cloudflare/compose.tunnel.yml` |
| Route count    | **156** `endpoint()` registrations                                                                 | generated in [`ERP_ENDPOINT_INVENTORY.md`](./ERP_ENDPOINT_INVENTORY.md)                |

The ERP's own documentation explicitly warns that its OpenAPI document is "a useful boundary
inventory, not a claim that every response model is fully formalized" (`docs/API.md`). This
report follows the same discipline: endpoints below are verified to exist; response **fields**
are cited where the implementation returns them.

---

## 2. Authentication mechanism (question 3)

### 2.1 How it works

1. `POST /api/v1/auth/login` with `{ email, password, totp? }` creates a row in `sessions`
   (`token_hash`, `csrf_token`, `expires_at`) and sets an `HttpOnly` cookie `duka_session`
   (`apps/api/src/services/auth.ts:186-258`).
2. Every `/api/v1` request passes through `authenticate`, which resolves the cookie to an
   actor by joining `sessions → identities`, then loads permissions, approval limit, branch
   and warehouse assignments (`auth.ts:259-298`).
3. **Every non-GET request additionally requires** `X-CSRF-Token` equal to the session's
   CSRF token (`auth.ts:309-317`).
4. **Every non-GET request must carry an `Origin` header that the ERP allowlists**, or it is
   rejected with `403 ORIGIN_DENIED`; `Sec-Fetch-Site: cross-site` is rejected too
   (`app.ts:91-111`). The allowed list is `ALLOWED_ORIGINS`/`WEB_ORIGIN` plus localhost in
   development.
5. Login is rate limited to 30 attempts per IP and 10 per email per 15 minutes
   (`auth.ts:191-192`).
6. Session lifetime is `SESSION_HOURS` (default **12**), and every session can be revoked
   (`auth.ts:236-245`, `POST /api/v1/auth/sessions/:id/revoke`).

### 2.2 What does **not** exist

- No API keys, personal access tokens, OAuth client credentials, mTLS or signed
  service-to-service tokens.
- No "integration user" concept distinct from a human identity. An identity is an email +
  argon2id password, optionally with TOTP.
- No unauthenticated machine endpoint (only `/health/live`, `/health/ready`,
  `/api/v1/openapi.json`, `/api/v1/docs` and the M-Pesa callback URL).

### 2.3 Consequence for the adapter

The e-commerce ERP adapter must:

- authenticate with a **dedicated least-privilege ERP identity** whose password lives in a
  secret store (never in git, never in the database);
- keep the cookie + CSRF token in memory, single-flight the login (two concurrent 401s must
  not trigger two logins, because of the email rate limit);
- send an `Origin` header that the ERP allowlists. Two supported options:
  1. the ERP operator adds the e-commerce API origin to the ERP's `ALLOWED_ORIGINS`
     (configuration only, no code change — **recommended**), or
  2. the adapter sends the ERP's own web origin as `Origin`
     (`ERP_ALLOWED_ORIGIN` in `.env.example`).
- re-login on `401`, back off on `429`, and never log the password, cookie or CSRF token.

Both mechanisms are implemented in `packages/erp-adapter/src/http-transport.ts` and covered
by adapter contract tests.

---

## 3. API conventions that the adapter must honour

| Convention     | Detail                                                                                                                                                                                                     | Evidence                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Versioning     | Everything under `/api/v1`; `/health/*` is outside it                                                                                                                                                      | `app.ts:113-120,198`                                                                                        |
| Idempotency    | All registered mutations default to idempotent (`endpoint()` sets `idempotent = method !== get/delete`), require `Idempotency-Key`, store the response per company+operation+key and reject a changed body | `apps/api/src/http.ts:44-58,88-96`, `apps/api/src/db.ts:260`, migration `001_core.sql` (`idempotency_keys`) |
| CSRF           | Required on all mutations with a session                                                                                                                                                                   | `auth.ts:309-317`                                                                                           |
| Origin         | Required on all mutations                                                                                                                                                                                  | `app.ts:91-111`                                                                                             |
| Validation     | Strict Zod schemas; unknown fields rejected with `422 VALIDATION_ERROR`                                                                                                                                    | `http.ts:78-85`                                                                                             |
| Decimals       | Money and quantities are decimal **strings**                                                                                                                                                               | `packages/shared/src/index.ts` (`amount`, `cost`)                                                           |
| Pagination     | `page` (≥1) and `limit` (1–100), plus `from`/`to`/`branch_id`/`warehouse_id` filters                                                                                                                       | `http.ts:9-38`                                                                                              |
| Errors         | Stable codes: `VALIDATION_ERROR`, `FORBIDDEN`, `INVALID_STATE`, `IDEMPOTENCY_*`, `TRANSACTION_BUSY`, `QUERY_TIMEOUT`, `RATE_LIMITED`                                                                       | `app.ts:202-268`                                                                                            |
| Retry contract | After a timeout, retry the **same** idempotency key; a later 401/403 does not disprove an earlier commit                                                                                                   | ERP `docs/API.md`                                                                                           |

---

## 4. Product and variant schema (question 4)

### 4.1 What exists

`products` is a single table that also models variants by self-reference:

```sql
-- database/migrations/001_core.sql:80
CREATE TABLE products (
  id uuid PRIMARY KEY, company_id uuid NOT NULL,
  name text NOT NULL, description text, sku text NOT NULL, barcode text,
  category_id uuid, unit_id uuid NOT NULL, tax_rule_id uuid NOT NULL,
  supplier_id uuid, parent_id uuid,                       -- <-- variants are child products
  kind text CHECK (kind IN ('stock','service','bundle')),
  brand text, manufacturer text,
  price numeric(20,2), purchase_cost numeric(24,6), min_price numeric(20,2),
  tax_inclusive boolean, reorder_level numeric(24,6), max_stock numeric(24,6),
  batch_tracked boolean, serial_tracked boolean, expiry_tracked boolean,
  active boolean, created_at, updated_at,
  UNIQUE (company_id, sku), UNIQUE (company_id, barcode),
  FOREIGN KEY (company_id, parent_id) REFERENCES products(company_id, id)
);
```

Related tables: `product_barcodes`, `product_units` (unit conversions), `bundle_components`,
`categories` (self-referencing), `units`, `tax_rules` (versioned), `price_lists` + `prices`
(price-list/customer/supplier tiers), `attachments` (private files).

### 4.2 Read path used by the adapter

`GET /api/v1/products` (`catalog.read`) returns per product: `name, sku, barcode,
description, brand, manufacturer, kind, price, tax_rate, tax_kind, unit, category,
parent_id, stock, reserved, stock_value, active, image_attachment_id`, paginated 1–100 and
searchable by name/SKU/barcode/category (`apps/api/src/services/catalog.ts:123-171`).
`purchase_cost`/`average_cost` are **redacted** for actors without cost permissions
(`catalog.ts:157`, `db.ts:112-140`) — good: the integration identity should not see costs.

`GET /api/v1/catalog/export` returns the same page as CSV (`routes/index.ts:2563`).

### 4.3 Gaps

1. **No variant option/attribute model.** There is no size/colour matrix, no option values,
   no per-variant attribute set (verified: no `attribute`, `option` or `variant` tables exist
   in `database/migrations/`). A merchant's variant is simply a child product with its own
   SKU and price.
2. **No variant images.** Images are private `attachments` (require authentication to fetch:
   `GET /api/v1/attachments/:id`), so they cannot be hot-linked from a public storefront.
3. **No channel/visibility flags.** `active` is the only publication control; there is no
   "sell online" flag, web title, slug, SEO fields or merchandising order.
4. **No bulk diff/sync cursor.** `updated_at` exists but no `updated_since` filter is
   exposed; the adapter must page the whole catalogue (≤100 per request) and diff locally.

The e-commerce schema therefore adds `brand`, `product_attribute`(+assignments),
`product_option`/`product_option_value` (from the approved ERD), slugs, SEO fields and
`sync_state`. ERP ids are stored in `erp_entity_map`, so the ERP stays the system of record
for price and stock while merchandising lives in e-commerce.

---

## 5. Inventory management and stock reservation (question 5)

### 5.1 What exists

- `stock_balances (company_id, product_id, warehouse_id)` with `quantity`, `value`,
  `reserved`, `version`; **`reserved <= quantity`** is enforced by a CHECK
  (`001_core.sql:126-130`).
- Append-only `stock_movements` with per-source uniqueness
  (`UNIQUE(company_id, source_type, source_id, line_key, product_id, warehouse_id)`), and
  `stock_batches`, `serial_numbers`, `stock_documents` (opening/adjustment/transfer/count).
- `stock_reservations (document_id, product_id, warehouse_id, quantity, status)`
  (`001_core.sql:240`). Reservations are created **only** when a `sales_order` document is
  approved, and released only when that document is cancelled
  (`apps/api/src/services/business.ts:247-338`).
- Availability is computed as `quantity - reserved`, exposed by
  `GET /api/v1/inventory/balances` as `available` (`services/inventory.ts:262`) and by
  `GET /api/v1/pos/products/:id/availability`.

### 5.2 Gaps relevant to a web checkout

| Gap                                             | Consequence                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `POST /inventory/reservations` (TTL-bearing) | A cart cannot reserve stock without creating and approving an ERP sales order.                                                                                                                                                                                                                                                |
| No reservation expiry                           | A crashed checkout would hold stock indefinitely.                                                                                                                                                                                                                                                                             |
| No per-channel reservation or allocation policy | Web, POS and van sales compete for the same pool with no fairness control.                                                                                                                                                                                                                                                    |
| Approval gate on `sales_order` documents        | Approving requires `documents.write` + `sales.price_override`, an approval limit ≥ order total, and **self-approval disabled unless company setting `allowSelfApproval` is true** (`business.ts:240-246`, `shifts.ts:17-37`). A single integration identity cannot create _and_ approve its own order under default settings. |
| No stock-change events                          | The storefront cannot be notified of stock changes; polling is the only option.                                                                                                                                                                                                                                               |

### 5.3 Phase 1 decision (implemented)

- **The e-commerce database owns cart/order reservations** (`inventory_reservation` with
  `expires_at`, statuses `active/consumed/released/expired`) with row-level locking on
  `product_variant` and an oversell guard.
- `product_variant.qty_in_stock` is a **mirror** of ERP `quantity` refreshed by the
  inventory sync; ERP `reserved` is stored in `erp_entity_map.metadata` for visibility.
- `ERP_RESERVE_ORDERS_IN_ERP=false` by default. When the operator explicitly enables it (and
  the ERP is configured with a second approving identity or `allowSelfApproval`), the adapter
  creates a `sales_order` document and approves it, so both systems reserve.
  This is **opt-in because it can double-reserve and it depends on ERP policy decisions.**
- Paid orders are mirrored to the ERP as a sale **only if** a register/shift mapping is
  configured; otherwise the order is queued as `failed` in `erp_sync_job` with a readable
  reason and no partial ERP state.

---

## 6. Customer management (question 6)

`GET /customers`, `POST /customers`, `PUT /customers/:id` (`customers.read`/`customers.write`),
`GET /customers/:id/statement`, `GET /customers/:id/open-items`,
`POST /customers/settlements` (`payments.receive`), `POST /customers/advances/apply`
(`apps/api/src/routes/index.ts:603-661`).

Customer fields are `name, code, email, phone, address, tax_pin, credit_limit, credit_days,
discount_percent, active` + optional `route_id` (`packages/shared/src/index.ts:133-148`).
`code` is **required and unique per company**; names are not unique. Creation is an upsert by
page behaviour, not by email — the adapter must search first (`GET /customers?q=`) and then
create, otherwise duplicates accumulate.

**Mapping implemented:** e-commerce `customer` → ERP `customer`. The adapter

1. looks up `erp_entity_map` by local customer id;
2. if absent, searches ERP by email via `GET /customers?q=<email>`;
3. creates with a deterministic code `WEB-<customer_id>` when nothing matches;
4. stores the mapping and ERP code in `erp_entity_map`.

Guests are **not** pushed to the ERP (no fake customer rows anywhere). Only registered
customers with an order or an explicit request are mapped. Because ERP rows require `name`,
guests' names would have to be invented — rejected by design.

---

## 7. Sales order creation (question 7)

`POST /api/v1/sales` (`sales.create`) is the only atomic checkout (`routes/index.ts:691`,
`services/sales.ts:26-…`). Verified preconditions:

1. `register_id` must exist and be active; the actor must have branch **and** warehouse access
   to that register's location (`sales.ts:29-40`).
2. A shift must exist for **that register, that cashier and status open/rejected**, and it is
   row-locked (`sales.ts:34-38`). A shift is opened with `POST /shifts/open` against a
   register (`services/shifts.ts:39`).
3. Lines are re-priced server-side (`priceCart`); client totals are never trusted.
4. Tenders (`payments[]` with `method_id`) plus any customer credit must settle the sale
   unless a customer is attached; `CHECK (customer_id IS NOT NULL OR paid_at_sale = total)`
   (`001_core.sql:153-165`).
5. The sale posts stock movements and a balanced journal in the same transaction; fiscal mode
   can block checkout with `503 FISCAL_UNAVAILABLE`.

**Gap:** there is no way to post a web order without a human-owned open shift. `POST
/documents` + `/documents/:id/transition` (kind `sales_order`, then `approved`) is the closest
reusable path — it reserves stock — but it is not a sale, requires approval rights, and then
needs a POS cashier to convert it (`POST /sales` with `order_id`) to create the invoice.

**Phase 1 decision:** the e-commerce order is authoritative for the storefront, and the ERP
sale is mirrored through the adapter **only when a register/shift mapping is configured**;
otherwise the sync job fails closed and is visible in the admin UI with the exact reason and
the missing ERP capability. No fake shifts, no fake registers, no "invented" endpoints.

---

## 8. Accounting and payment posting (questions 8)

| Capability                                   | Endpoint                                                                       | Permission               | Reusable?                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------ | ----------------------------------------- |
| Sales → balanced journal, stock, receivables | `POST /sales`                                                                  | `sales.create`           | Yes, but requires an open shift (§7)      |
| Customer receipt / settlement & allocation   | `POST /customers/settlements`                                                  | `payments.receive`       | Yes (recording only)                      |
| Customer advances                            | `POST /customers/advances/apply`                                               | `payments.receive`       | Yes                                       |
| Payments list                                | `GET /payments`, `GET /payments/refunds`                                       | `payments.receive`/`pay` | Yes (read)                                |
| Refund settlement confirmation               | `POST /payments/refunds/:id/confirm`                                           | `payments.pay`           | Yes                                       |
| Sales return / credit note                   | `POST /sales/returns`                                                          | `sales.return`           | Yes                                       |
| Manual journal                               | `POST /accounting/journals`                                                    | `accounting.post`        | Yes, with period locks                    |
| Journal reversal                             | `POST /accounting/journals/:id/reverse`                                        | `accounting.reverse`     | Yes                                       |
| Trial balance / P&L / balance sheet / tax    | `GET /reports/:name`                                                           | `reports.read`           | Yes (read)                                |
| M-Pesa STK push + callback                   | `POST /integrations/mpesa/intents`, `POST /integrations/mpesa/callback/:token` | `sales.create` (intent)  | Sandbox/live by config; mock mode for dev |
| Card acquiring                               | —                                                                              | —                        | **Does not exist**                        |

Journal writes are guarded: `journals` has `UNIQUE(company_id, source_type, source_id)`, a
`journal_lines` balance trigger and period-lock checks (`database/migrations/004, 012`).
This is a genuinely strong subsystem and it is the reason the ERP should stay the accounting
system of record — the e-commerce project must never post journals directly.

**Phase 1 decision:** e-commerce records **payment attempts and outcomes** locally
(`payment_transaction`, `payment_webhook`, `payment`), and mirrors accepted payments to the
ERP only through the documented settlement/sale endpoints. Card acquisition is out of scope
for the ERP and stays an e-commerce provider concern; in Phase 1 the only enabled provider is
`manual` (no capture) plus a disabled M-Pesa adapter and a test-only fake provider.

---

## 9. Endpoint reuse matrix (question 9)

Verified against the generated inventory; permission names are exact.

| E-commerce need                                                                                 | ERP endpoint                                                 | Method       | Permission                                           | Notes / constraints                                               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------ | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Bootstrap ids (branches, warehouses, registers, units, tax rules, payment methods, price lists) | `/api/v1/metadata`                                           | GET          | any authenticated                                    | Scoped to the integration identity's branch/warehouse assignments |
| Product catalogue sync                                                                          | `/api/v1/products`                                           | GET          | `catalog.read`                                       | Page ≤ 100; `active=all` supported; costs redacted                |
| Category sync                                                                                   | `/api/v1/metadata` (`categories`), or per-product `category` | GET          | —                                                    | No standalone category endpoint                                   |
| Stock/availability sync                                                                         | `/api/v1/inventory/balances`                                 | GET          | `inventory.read`                                     | Returns `available`, `reserved`, `version`                        |
| Stock movement audit                                                                            | `/api/v1/inventory/movements`                                | GET          | `inventory.read`                                     | Append-only ledger                                                |
| Customer search/create/update                                                                   | `/api/v1/customers`                                          | GET/POST/PUT | `customers.read`/`.write`                            | `code` required, unique per company                               |
| Order reservation mirror (opt-in)                                                               | `/api/v1/documents` + `/documents/:id/transition`            | POST         | `documents.write` + `sales.price_override` (approve) | Approval limit + self-approval policy apply                       |
| Post sale / invoice                                                                             | `/api/v1/sales`                                              | POST         | `sales.create`                                       | Requires active register + open shift for the identity            |
| Price quote without posting                                                                     | `/api/v1/pos/price`                                          | POST         | `sales.create`                                       | Useful to validate totals against ERP pricing                     |
| Record payment                                                                                  | `/api/v1/customers/settlements`                              | POST         | `payments.receive`                                   | Allocation-based                                                  |
| Refund                                                                                          | `/api/v1/sales/returns`                                      | POST         | `sales.return`                                       | Capped by original sale lines                                     |
| Payment status read                                                                             | `/api/v1/payments`, `/api/v1/sales/:id`                      | GET          | `sales.read`/`payments.*`                            | UUID-keyed                                                        |
| Health probe                                                                                    | `/health/live`, `/health/ready`                              | GET          | none                                                 | Unauthenticated                                                   |
| Capability probe                                                                                | `/api/v1/openapi.json`                                       | GET          | none                                                 | Generated from the live route registry                            |
| Audit trail                                                                                     | `/api/v1/audit`                                              | GET          | `audits.read`                                        | Company-wide                                                      |

Not reused (deliberately): `/pos/suspended` (POS-local carts), `/offline/*` (device capture),
`/shipping`-like routes (none exist), `/accounting/journals` direct posting (ERP owns
accounting), `/integrations/fiscal` (certified fiscal adapter is an ERP concern).

---

## 10. Missing endpoints required by e-commerce (question 10)

Each gap below has an implementation-ready contract in
[`ERP_INTEGRATION_CONTRACT.md`](./ERP_INTEGRATION_CONTRACT.md). None is invented in code: the
adapter marks these capabilities `unsupported` and the UI/sync reports them explicitly.

| #   | Missing capability                                                      | Why needed                                                                                           | Proposed endpoint                                                                                               |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| G1  | **Machine authentication** (API keys / OAuth client credentials / mTLS) | Password+TOTP session is brittle for a server; 12 h expiry and login throttling force re-auth storms | `POST /api/v1/integration/tokens` (client credentials), scoped, short-lived, rotating                           |
| G2  | **Capability/version discovery**                                        | Adapter must fail fast when a deployment lacks a capability                                          | `GET /api/v1/integration/capabilities`                                                                          |
| G3  | **TTL reservations** with release                                       | Cart-level hold without an approved sales order                                                      | `POST /api/v1/integration/reservations`, `DELETE …/:id`, `GET /api/v1/integration/availability`                 |
| G4  | **Channel order creation** without a cashier shift                      | Web checkout must post an order atomically                                                           | `POST /api/v1/integration/orders` (+ `GET …/:id`, `POST …/:id/cancel`)                                          |
| G5  | **Idempotent payment posting by external reference**                    | Mirror succeeded provider payments without inventing a shift/method                                  | `POST /api/v1/integration/payments`                                                                             |
| G6  | **Refund by external reference**                                        | Refund the mirrored payment without POS interaction                                                  | `POST /api/v1/integration/refunds`                                                                              |
| G7  | **Shipment/delivery-note creation with carrier + tracking**             | Fulfilment status for the storefront                                                                 | `POST /api/v1/integration/shipments`, `PATCH …/:id`                                                             |
| G8  | **Outbound events/webhooks** (signed, retried)                          | Stock/price changes without polling every product                                                    | `POST /api/v1/integration/subscriptions` → `product.updated`, `stock.changed`, `order.paid`, `shipment.updated` |
| G9  | **Public product media** (signed/public URLs or image variants)         | Storefront cannot hot-link private attachments                                                       | `GET /api/v1/integration/media/:attachment_id` with short-lived signed URL                                      |
| G10 | **Variant/option read model**                                           | Size/colour selectors, per-variant SKUs and images                                                   | Extend `GET /api/v1/products` (or `/integration/variants`) with `options[]`, `attributes[]`, `images[]`         |
| G11 | **Incremental catalogue cursor**                                        | Avoid full-catalogue paging on every sync                                                            | `GET /api/v1/integration/products?updated_since=…&cursor=…`                                                     |
| G12 | **Register/shift automation for a channel**                             | Alternative to G4 if the ERP prefers POS semantics                                                   | `POST /api/v1/integration/registers/:id/shifts` with `channel` + explicit reason                                |

Until these exist, the adapter exposes them as explicit `unsupported` capabilities. The
sync layer never fabricates an ERP id or marks a job `succeeded` without an ERP response.

---

## 11. Recommended ERP integration identity

Create a dedicated ERP identity (e.g. `integration@shop.<domain>`) with a single role
`ecommerce_integration` holding only:

| Permission                          | Used for                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `catalog.read`                      | product/category sync                                                            |
| `inventory.read`                    | stock sync                                                                       |
| `customers.read`, `customers.write` | customer mapping                                                                 |
| `documents.write`                   | optional order reservation documents                                             |
| `sales.price_override`              | **only if** ERP reservation-by-approval is enabled (needs an approval limit too) |
| `sales.create`                      | optional sale postings and M-Pesa intents                                        |
| `payments.receive`                  | payment mirroring                                                                |
| `sales.return`                      | refund mirroring                                                                 |

Not granted: `accounting.*`, `audits.read`, `users.manage`, `settings.manage`, `purchases.*`,
`expenses.*`. Branch/warehouse assignments should be exactly the web fulfilment locations.

Operational notes: use HTTPS only; store the password in a secret store; rotate it; monitor
`security_event` for repeated `login.failed`; remember the 10-per-15-minutes login limit when
restarting many e-commerce replicas.

---

## 12. Evidence and limitations

**Inspected (read-only):**

- `apps/api/src/app.ts`, `http.ts`, `db.ts`, `readiness.ts`
- `apps/api/src/routes/index.ts` (all 156 endpoints; machine-extracted)
- `apps/api/src/services/{auth,sales,catalog,inventory,business,shifts,payments,admin}.ts`
- `apps/api/src/integrations/{mpesa,fiscal,worker}.ts`
- `database/migrations/001_core.sql` … `029_route_sales.sql`
- `packages/shared/src/index.ts` (Zod schemas), `packages/{accounting,inventory}/src/index.ts`
- `../duka/deploy/docker/compose.yml`, `../duka/deploy/cloudflare/compose.tunnel.yml`
- `docs/API.md`, `README.md`

**Limitations — stated plainly:**

1. **No ERP server access was available**, only the repository. No request was sent to a
   running ERP. The adapter therefore has functional tests against a protocol-faithful fake
   transport (which reproduces the ERP's documented envelope, CSRF, Origin, idempotency and
   error codes) and a **read-only probe** (`GET /health/live`, `GET /api/v1/auth/me`,
   `GET /api/v1/openapi.json`) that an operator can run against the real deployment before
   enabling sync. Nothing in this report claims a live ERP integration was verified.
2. Response **field sets** were read from the service SQL, not from a live response. Any
   divergence will surface as a sync error, never as silent data loss: mapping is transactional
   and jobs are retried with logs.
3. The ERP's deployment topology (Cloudflare Tunnel, private API) means the e-commerce API
   must reach the ERP over the private network or a scoped tunnel route; this is an ops
   decision, documented in `DEPLOYMENT.md`.
4. Permission names were verified in code; the _set of roles_ that hold them in a given
   deployment must be confirmed by the operator in the ERP's `/api/v1/metadata`.

---

## 13. Risks and mitigations

| Risk                                      | Mitigation implemented                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Session expiry (12 h) breaks sync mid-run | Single-flight re-login on 401, one retry, exponential backoff; sync job records the failure                                                     |
| Login rate limiting during redeploys      | One login per process, token reused until expiry minus a safety margin                                                                          |
| `Origin` rejection                        | Explicit `ERP_ALLOWED_ORIGIN` setting; documented operator step; clear `ERP_UNAVAILABLE` error with the ERP code                                |
| Double reservation (local + ERP)          | ERP reservation disabled by default; single-owner policy documented                                                                             |
| Overselling                               | Local reservations with row locks, TTLs and DB constraints; ERP mirror never decreases stock locally                                            |
| Duplicate orders/payments                 | Deterministic idempotency keys derived from local ids (`erp:order:<id>:create`), stored in `erp_sync_log.idempotency_key` and in the ERP itself |
| Cost data leakage                         | Adapter's identity has no cost permissions; e-commerce never stores ERP cost fields                                                             |
| Silent failure                            | Every push is a durable `erp_sync_job` with attempts, `next_attempt_at`, last error and a linked `erp_sync_log`                                 |

---

## 14. Verdict

The ERP is **reusable over its HTTP API** for catalogue, stock reads, customer mapping and
payment/refund mirroring, with caveats. It is **not** reusable, as deployed today, for
web-native order posting or TTL stock reservation: those require either ERP-side additions
(G1–G12) or an operator decision to automate a register/shift and an approving identity.

Phase 1 therefore implements a complete, tested e-commerce foundation with:

- local carts, reservations, orders, payment ledger, shipments and refunds;
- an isolated ERP adapter that uses only verified endpoints, with explicit unsupported
  capabilities, retries, idempotency and durable sync logs;
- no direct ERP database access, no fabricated endpoints, no fake success states, and no
  change to the running ERP.
