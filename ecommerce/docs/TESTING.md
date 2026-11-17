# Testing

Run everything:

```bash
npm test           # unit + integration, embedded PostgreSQL (PGlite)
npm run test:unit
npm run test:integration
npm run test:pg-concurrency   # only when TEST_DATABASE_URL is set
npm run typecheck
```

The default suite starts a real PostgreSQL engine (PGlite, one connection) in a
temporary directory per test file, applies the real migrations, boots the real
Express app and drives it over HTTP with cookies and CSRF — no mocks of our own
code. The ERP and the payment provider are the only doubles, and both are
protocol-faithful fakes that refuse to load in production.

## What is proven (112 tests)

**Migrations and schema** (`tests/integration/migrations.test.ts`, `constraints.test.ts`)

- All 6 migrations apply once, re-run as a no-op, and report `applied`.
- Editing an already-applied migration is rejected (checksum, forward-only).
- Every table from the approved ERD plus the extensions exists.
- Reference data is present and **no** customer/product/order sample data.
- Constraints actually bite: unique/lower-case emails, order-total arithmetic,
  review rating 1–5 and one review per line, single cart owner, one active cart
  per customer, positive reservation quantity, one active reservation per
  cart+variant, positive payments, one payment per transaction, single default
  address/payment method, ERP mapping uniqueness in both directions, promotion
  windows, idempotency uniqueness.

**Identity and sessions** (`auth.test.ts`)

- Registration/login/logout, hashed session cookies, CSRF and Origin enforcement.
- Admin realm isolation: a customer cookie never reaches `/admin/*`, admin login
  never mints a storefront session, and role permissions are enforced (auditor
  cannot mutate the catalogue).
- Guests cannot be escalated; a second `/auth/guest` never replaces an identity.
- Password change verifies the current password and revokes other sessions.
- Repeated failed logins are rate limited.

**Catalogue, cart and stock** (`cart.test.ts`)

- Only published products are visible; drafts stay private.
- Cart writes work for anonymous visitors and hand back a CSRF token.
- Overselling is refused with the real availability in `details`.
- Quantity updates, removal and clearing release holds.
- Expired holds are swept and stock becomes available again.
- Carts are private; another customer cannot touch a line.

**Checkout and orders** (`orders.test.ts`)

- Prices are snapshotted; totals, shipping and stock movement are asserted.
- Holds are consumed, the cart is converted, a new cart starts.
- Checkout is idempotent: identical retry returns the same order, changed body
  with the same key is `409`, missing key is `422`.
- Empty cart, unknown shipping method, guest email requirement.
- Ownership: a stranger receives `404`, not someone else's order.
- Cancellation restores stock and is terminal.
- The last unit cannot be held twice.

**Order lookup and delivery options** (`order-lookup.test.ts`)

- `GET /catalog/shipping-methods` is public, returns the seeded fees, and drops
  options the store deactivates (old orders keep the name they were placed with).
- An order is found from a fresh client with no cookie and no CSRF token, using
  only the order number and the checkout email; the number matches
  case-insensitively and ignores surrounding whitespace.
- A wrong email, a wrong number and an unknown number all return the same `404`
  with the same message, so neither half can be probed.
- Malformed or extra fields are `422` before the database is touched.
- Repeated misses from one address hit the rate limit (`429 RATE_LIMITED`).

**Catalogue administration** (`admin-catalog.test.ts`)

- A product is created with variants, a generated slug, a brand and a category;
  the first variant is the default one.
- Publishing is a real gate: a draft is `404` on the storefront until it is
  published, and a product with no active variant cannot be published (`422`),
  whether by editing or by creating it as active.
- `is_featured` moves a product on and off the landing-page query, and only
  featured products answer `?featured=true`.
- Variants are added individually (with options) and unpublished one at a time;
  an unpublished variant disappears from the product page and cannot be added to
  a cart. Prices are editable, a negative price or a compare-at below the price is
  `422`, a compare-at can be cleared with `null`, and a duplicate SKU or slug is
  `409`.
- `catalog.write` is required to create or change anything; `catalog.read` is
  enough to look (a `support` admin is refused with `403`).
- A guest cart follows the shopper into a new account (the cart row is adopted,
  so lines and stock holds survive), signing in adopts it too when the account
  has no cart, and an account that already has a cart keeps its own lines.

**Product images** (`product-images.test.ts`)

- The adapter lists a product's image attachments and downloads their bytes
  unchanged (a real PNG round-trips), and a transport without binary support
  reports the capability as unsupported instead of returning an empty image.
- A catalogue pull writes the ERP attachment into `product_image` as
  `/api/v1/catalog/images/<id>` — the shop's own URL, not the ERP's host — and a
  replacement photo in the ERP replaces the stored URL on the next pull.
- `GET /api/v1/catalog/images/:id` serves the ERP bytes with a long cache header
  for a published product, and `404` for an unknown id, a malformed id, a path
  traversal attempt, or a product that is not published.
- With the ERP unreachable the route answers a 1×1 transparent PNG with
  `cache-control: no-store`, so a tile degrades quietly and nothing is cached.
- An operator can set, replace and clear a product's primary image; `javascript:`,
  `data:` and protocol-relative URLs are `422`, and a site-relative path is allowed.

**Payments** (`payments-manual.test.ts`, `payments-webhook.test.ts`)

- Manual mode never claims capture; the health endpoint says so.
- Administrators record confirmed payments; over-payment is refused; paid orders
  cannot be cancelled.
- Refunds require idempotency, respect the refundable balance, replay safely and
  need `refunds.write`.
- Webhooks: invalid signature is recorded then rejected with no state change;
  unknown reference is inert; a signed success marks the order paid exactly once;
  duplicate delivery does not double-credit; failure moves the order to
  `payment_failed`; a non-active provider is `404`.

**ERP adapter and sync** (`erp-adapter.test.ts`, `sync.test.ts`, `worker.test.ts`)

- Single-flight login, one re-login on 401, Origin on mutations.
- Pagination terminates; catalogue and inventory pull into the local schema with
  entity mappings, and a second pull updates instead of duplicating.
- Customer search-then-create, idempotent create, conflict typing.
- The ERP's real constraints surface: self-approval is refused, `POST /sales`
  without an open shift fails.
- Retries: 5xx retried with backoff then `ERP_UNAVAILABLE`; 429 typed and
  retryable.
- Order push creates the ERP document once, maps it, and a second push is a
  no-op; checkout queues the job only when integration is enabled.
- Unsupported capability (`push_refund`) dies with `UNSUPPORTED_CAPABILITY` and
  the contract reference; transient failure schedules a backed-off retry.
- Worker tick expires holds and writes a heartbeat that `/health/ready` reads.

**Shared money/identity helpers, ERP contract integrity** (`tests/unit`)

- Decimal rounding, decimal-string validation, Kenyan phone normalisation,
  slugify, deterministic request hashing.
- Every ERP capability has evidence; unsupported ones cite a contract gap; the
  adapter refuses unsupported methods without sending a request.

## What is _not_ proven here

| Claim                           | Why not                                               | How to close it                                                     |
| ------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| Multi-connection races on stock | PGlite is a single connection                         | `TEST_DATABASE_URL=… npm run test:pg-concurrency`                   |
| Live M-Pesa STK/callback/refund | No Daraja sandbox credentials, no public callback URL | Run against Daraja sandbox with `MPESA_MODE=sandbox` and a tunnel   |
| Real ERP interoperability       | Phase 1 must not write to the ERP                     | Run the adapter against a staging ERP with the integration identity |
| Load/soak behaviour             | Out of Phase 1 scope                                  | k6/artillery against staging                                        |
| Email/SMS delivery              | Not in Phase 1                                        | Provider integration + outbox pattern                               |

The suite never marks a skipped proof as passed: the PostgreSQL test reports
`SKIP` unless `TEST_DATABASE_URL` is set.
