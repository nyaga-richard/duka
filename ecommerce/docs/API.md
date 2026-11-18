# API reference

Generated from the runtime route registry by `npx tsx scripts/api-docs.ts`.
Do not edit by hand.

**58 endpoints.** Base path `/api/v1`. Interactive docs: `GET /api/v1/docs`, machine readable: `GET /api/v1/openapi.json`.

## Conventions

- Success: `{ "data": …, "meta": { "request_id": "…" } }`.
- Errors: `{ "error": { "code", "message", "details?", "request_id" } }`; quote the request id in support.
- Every state-changing request needs an `Origin` header from the allowlist **and** the `X-CSRF-Token` returned when the session was created (`/auth/me` returns the current token).
- `Idempotency-Key` is mandatory where marked; reusing a key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.
- Provider webhooks are exempt from CSRF/Origin and are authenticated by HMAC instead.
- `GET /api/v1/catalog/images/:attachmentId` is the one binary response: raw image bytes, `cache-control: public, max-age=600`, and a 1×1 transparent PNG with `no-store` when the ERP cannot be reached.

| Method | Path                                           | Auth                      | Permissions       | Idempotent | Description                                                                    |
| ------ | ---------------------------------------------- | ------------------------- | ----------------- | ---------- | ------------------------------------------------------------------------------ |
| GET    | `/api/v1/admin/audit-logs`                     | administrator session     | `audit.read`      | —          | Audit trail                                                                    |
| POST   | `/api/v1/admin/auth/login`                     | public                    | —                 | —          | Store administrator sign-in (separate identity realm)                          |
| GET    | `/api/v1/admin/customers`                      | administrator session     | `customers.read`  | —          | Search registered customers                                                    |
| GET    | `/api/v1/admin/erp/capabilities`               | administrator session     | `sync.manage`     | —          | Verified vs missing ERP capabilities                                           |
| GET    | `/api/v1/admin/erp/mappings`                   | administrator session     | `sync.manage`     | —          | Local ↔ ERP entity mappings                                                   |
| POST   | `/api/v1/admin/erp/probe`                      | administrator session     | `sync.manage`     | —          | Probe ERP health, identity and permissions (read-only)                         |
| POST   | `/api/v1/admin/erp/queue-catalog-pull`         | administrator session     | `sync.manage`     | —          | Enqueue a catalogue pull for the worker                                        |
| GET    | `/api/v1/admin/orders`                         | administrator session     | `orders.read`     | —          | Search orders across the store                                                 |
| GET    | `/api/v1/admin/orders/:orderId`                | administrator session     | `orders.read`     | —          | Full order detail                                                              |
| POST   | `/api/v1/admin/orders/:orderId/payment-intent` | administrator session     | `payments.write`  | —          | Retry the provider payment intent for a pending order                          |
| POST   | `/api/v1/admin/orders/:orderId/payments`       | administrator session     | `payments.write`  | —          | Record a confirmed manual payment (cash/bank) against an order                 |
| POST   | `/api/v1/admin/orders/:orderId/refunds`        | administrator session     | `refunds.write`   | —          | Refund a captured payment (requires Idempotency-Key)                           |
| POST   | `/api/v1/admin/orders/:orderId/shipments`      | administrator session     | `shipments.write` | —          | Create a shipment and mark the order shipped                                   |
| PATCH  | `/api/v1/admin/orders/:orderId/status`         | administrator session     | `orders.write`    | —          | Move an order through fulfilment (payment status is not settable here)         |
| GET    | `/api/v1/admin/payments/webhooks`              | administrator session     | `payments.read`   | —          | Inspect received provider webhooks                                             |
| GET    | `/api/v1/admin/products`                       | administrator session     | `catalog.read`    | —          | Catalogue with sync state                                                      |
| POST   | `/api/v1/admin/products`                       | administrator session     | `catalog.write`   | —          | Create a product locally with optional variants                                |
| GET    | `/api/v1/admin/products/:productId`            | administrator session     | `catalog.read`    | —          | One product with its variants, options and images                              |
| PATCH  | `/api/v1/admin/products/:productId`            | administrator session     | `catalog.write`   | —          | Edit a product's merchandising fields, publish state or feature flag           |
| PUT    | `/api/v1/admin/products/:productId/image`      | administrator session     | `catalog.write`   | —          | Set or clear a product's primary image (an https URL or the ERP proxy path)    |
| PATCH  | `/api/v1/admin/products/:productId/status`     | administrator session     | `catalog.write`   | —          | Publish or archive a product locally (ERP stays the stock/price master)        |
| POST   | `/api/v1/admin/products/:productId/variants`   | administrator session     | `catalog.write`   | —          | Add a variant (SKU, price, stock, options) to a product                        |
| PATCH  | `/api/v1/admin/reviews/:reviewId`              | administrator session     | `catalog.write`   | —          | Moderate a review                                                              |
| GET    | `/api/v1/admin/settings`                       | administrator session     | `settings.manage` | —          | Store, payment and ERP settings (no secrets)                                   |
| PUT    | `/api/v1/admin/settings/store`                 | administrator session     | `settings.manage` | —          | Update storefront settings                                                     |
| PATCH  | `/api/v1/admin/shipments/:shipmentId`          | administrator session     | `shipments.write` | —          | Update shipment tracking status                                                |
| POST   | `/api/v1/admin/sync/customers/:customerId`     | administrator session     | `sync.manage`     | —          | Map and push one customer to the ERP                                           |
| POST   | `/api/v1/admin/sync/orders/:orderId`           | administrator session     | `sync.manage`     | —          | Push one order to the ERP now                                                  |
| GET    | `/api/v1/admin/sync/overview`                  | administrator session     | `sync.manage`     | —          | ERP sync job and log overview                                                  |
| POST   | `/api/v1/admin/sync/process`                   | administrator session     | `sync.manage`     | —          | Process due ERP sync jobs now (worker also runs these)                         |
| POST   | `/api/v1/admin/sync/pull-catalog`              | administrator session     | `sync.manage`     | —          | Pull the ERP catalogue now (idempotent by nature)                              |
| POST   | `/api/v1/admin/sync/pull-inventory`            | administrator session     | `sync.manage`     | —          | Pull ERP stock balances now                                                    |
| PATCH  | `/api/v1/admin/variants/:variantId`            | administrator session     | `catalog.write`   | —          | Edit a variant, or take it off the storefront with is_active: false            |
| POST   | `/api/v1/auth/change-password`                 | customer session          | —                 | —          | Change a customer password and revoke other sessions                           |
| POST   | `/api/v1/auth/guest`                           | public                    | —                 | —          | Start a guest checkout identity                                                |
| POST   | `/api/v1/auth/login`                           | public                    | —                 | —          | Customer sign-in                                                               |
| POST   | `/api/v1/auth/logout`                          | any signed-in identity    | —                 | —          | Revoke the current session                                                     |
| GET    | `/api/v1/auth/me`                              | public                    | —                 | —          | Current identity and CSRF token                                                |
| POST   | `/api/v1/auth/register`                        | public                    | —                 | —          | Create a customer account and start a session                                  |
| GET    | `/api/v1/cart`                                 | public                    | —                 | —          | Current cart with live prices and availability                                 |
| POST   | `/api/v1/cart/clear`                           | customer or guest session | —                 | —          | Empty the cart and release all holds                                           |
| POST   | `/api/v1/cart/items`                           | public                    | —                 | —          | Add a variant to the cart and hold stock                                       |
| DELETE | `/api/v1/cart/items/:variantId`                | customer or guest session | —                 | —          | Remove a variant from the cart and release its hold                            |
| PATCH  | `/api/v1/cart/items/:variantId`                | customer or guest session | —                 | —          | Set a cart line quantity (0 removes it)                                        |
| GET    | `/api/v1/catalog/brands`                       | public                    | —                 | —          | Active brands                                                                  |
| GET    | `/api/v1/catalog/categories`                   | public                    | —                 | —          | Active categories with product counts                                          |
| GET    | `/api/v1/catalog/images/:attachmentId`         | public                    | —                 | —          | Published product image, proxied from its ERP attachment                       |
| GET    | `/api/v1/catalog/products`                     | public                    | —                 | —          | Browse published products with live availability                               |
| GET    | `/api/v1/catalog/products/:slug`               | public                    | —                 | —          | Product detail by slug or numeric id                                           |
| GET    | `/api/v1/catalog/products/:slug/reviews`       | public                    | —                 | —          | Published reviews for a product                                                |
| GET    | `/api/v1/catalog/shipping-methods`             | public                    | —                 | —          | Active delivery options with their fees and estimates                          |
| GET    | `/api/v1/orders`                               | customer or guest session | —                 | —          | List the signed-in customer's or guest's orders                                |
| POST   | `/api/v1/orders`                               | customer or guest session | —                 | required   | Place an order from the current cart (idempotent, reserves and consumes stock) |
| GET    | `/api/v1/orders/:orderId`                      | customer or guest session | —                 | —          | Order detail (own orders only)                                                 |
| POST   | `/api/v1/orders/:orderId/cancel`               | customer or guest session | —                 | —          | Cancel an unpaid order and restore stock                                       |
| POST   | `/api/v1/orders/lookup`                        | public                    | —                 | —          | Find one order by its number and the email used at checkout                    |
| POST   | `/api/v1/reviews`                              | customer session          | —                 | —          | Review a purchased item (one review per order line)                            |
| POST   | `/api/v1/webhooks/payments/:provider`          | public                    | —                 | —          | Provider payment webhook (HMAC-verified, deduplicated by event id)             |

## Error codes

| Code                       | Meaning                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `VALIDATION_ERROR`         | Payload or query failed schema validation (422).                                           |
| `UNAUTHENTICATED`          | No session for the required realm (401).                                                   |
| `INVALID_CREDENTIALS`      | Wrong email/password (401); the message never reveals which.                               |
| `EMAIL_TAKEN`              | Registration for an existing customer email (409).                                         |
| `FORBIDDEN`                | Authenticated but not allowed (403): permission, realm or ownership.                       |
| `CSRF_INVALID`             | Missing or stale X-CSRF-Token (403); fetch /auth/me for the current token.                 |
| `ORIGIN_DENIED`            | Origin missing or not in the allowlist (403).                                              |
| `NOT_FOUND`                | Unknown resource, or a resource the caller must not learn about (404).                     |
| `CONFLICT`                 | State conflict (409).                                                                      |
| `IDEMPOTENCY_REQUIRED`     | Operation needs an Idempotency-Key header (422).                                           |
| `IDEMPOTENCY_KEY_REUSED`   | Same key, different payload (409).                                                         |
| `IDEMPOTENCY_IN_PROGRESS`  | Identical request still running (409).                                                     |
| `INSUFFICIENT_STOCK`       | Not enough unreserved stock (409, with availability details).                              |
| `EMPTY_CART`               | Checkout with nothing in the cart (422).                                                   |
| `CART_RESERVATION_EXPIRED` | Holds expired before checkout completed (409).                                             |
| `INVALID_STATE_TRANSITION` | Order/shipment/refund does not allow that move (409).                                      |
| `PAYMENTS_DISABLED`        | Payment capture is switched off (503).                                                     |
| `PROVIDER_UNAVAILABLE`     | Payment provider unreachable (502).                                                        |
| `ERP_UNAVAILABLE`          | ERP unreachable after retries (502).                                                       |
| `ERP_CONTRACT_UNSUPPORTED` | The ERP does not expose the needed capability (501); see docs/ERP_INTEGRATION_CONTRACT.md. |
| `RATE_LIMITED`             | Too many attempts (429).                                                                   |
| `PAYLOAD_TOO_LARGE`        | Body over 256 kb (413).                                                                    |
| `INVALID_JSON`             | Malformed JSON body (400).                                                                 |
| `DEPENDENCY_NOT_READY`     | Database or migrations not ready (503).                                                    |
| `INTERNAL_ERROR`           | Unexpected failure (500); details stay in logs.                                            |

## Identity realms

| Realm         | Cookie               | Created by                                                   | Notes                                                                    |
| ------------- | -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Customer      | `ecom_session`       | `POST /auth/register`, `POST /auth/login`                    | Email + password (scrypt).                                               |
| Guest         | `ecom_guest`         | `POST /auth/guest`, or automatically on the first cart write | Optional email; required before guest checkout.                          |
| Administrator | `ecom_admin_session` | `POST /admin/auth/login`                                     | Separate table, roles and permissions; never shares a customer identity. |

Sessions are opaque random tokens stored only as SHA-256 digests, `HttpOnly`, `SameSite=Lax`, and revoked on logout and password change.
