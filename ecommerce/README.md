# Duka E-commerce — Phase 1 foundation

An independent e-commerce service for Duka. It is a separate TypeScript/Express
application with its own PostgreSQL database; it **never** writes to the ERP
database and only talks to the ERP over its documented HTTP API.

The ERP remains the master of products, prices and stock. This service owns the
storefront: identity, carts, stock holds, orders, payment records and the audit
trail that explains every state change.

## What is in the box

| Area                               | Where                    | State                                                   |
| ---------------------------------- | ------------------------ | ------------------------------------------------------- |
| Schema (6 forward-only migrations) | `database/migrations`    | Applied and tested                                      |
| HTTP API (49 endpoints)            | `apps/api/src`           | Implemented, tested                                     |
| Background worker                  | `apps/api/src/worker.ts` | Heartbeat, hold expiry, ERP retries                     |
| ERP adapter (isolated)             | `packages/erp-adapter`   | Verified capabilities only                              |
| Payments boundary                  | `packages/payments`      | `manual` default; M-Pesa untested live                  |
| Storefront + staff UI              | `apps/web`               | Catalogue, cart, checkout, orders, manual capture       |
| Tests                              | `tests`                  | 87 automated tests (plus a gated real-PostgreSQL proof) |
| Deployment                         | `docker`                 | Compose: PostgreSQL, API, worker, web                   |

Read first:

- [`docs/ERP_INTEGRATION_CAPABILITY_REPORT.md`](docs/ERP_INTEGRATION_CAPABILITY_REPORT.md) — what the ERP actually exposes.
- [`docs/ERP_INTEGRATION_CONTRACT.md`](docs/ERP_INTEGRATION_CONTRACT.md) — the 12 gaps that need an ERP-side contract.
- [`docs/ERP_ENDPOINT_INVENTORY.md`](docs/ERP_ENDPOINT_INVENTORY.md) — every ERP endpoint inspected.
- [`docs/API.md`](docs/API.md) — generated from the live route registry.
- [`docs/TESTING.md`](docs/TESTING.md) — what is proven, and what is explicitly not.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — deploy/run runbook.
- [`docs/PHASE1_REPORT.md`](docs/PHASE1_REPORT.md) — phase close-out against the brief.

## Quick start (local, no PostgreSQL needed)

```bash
cd ecommerce
npm install
cp .env.example .env             # DATABASE_URL defaults to embedded PGlite
npm run db:migrate               # 6 migrations
ADMIN_BOOTSTRAP_EMAIL=owner@duka.test ADMIN_BOOTSTRAP_PASSWORD='a-long-password' npm run db:seed

npm run dev                      # API on http://localhost:4100
npm run dev:web                  # storefront on http://localhost:3100
npm run dev:worker               # optional: holds expiry + ERP retries
```

The storefront proxies `/api/v1/*` to the API server-side, so cookies stay
first-party. Staff UI: <http://localhost:3100/admin>.

Catalogue pages stay empty until a catalogue source exists: either enable the
ERP integration and run a pull, or create products from the store desk at
`/admin`. No sample products or orders are seeded — a seed that invents business
data would make the tests lie. To look at the storefront with something in it:

```bash
npm run demo:catalogue           # optional: six products, two accounts, no orders
```

That script is opt-in and idempotent; it lives in `scripts/demo-catalogue.ts` and
its photos in `apps/web/public/seed`.

### Product photos

The storefront shows the ERP's own product image when the ERP has one. There is
nothing to configure: the catalogue pull stores the image attachment as
`/api/v1/catalog/images/<attachmentId>`, and that public route streams the bytes
from the ERP through the shop's own host (cached for ten minutes, only for
published products). Without an ERP photo, or while the ERP is unreachable, tiles
fall back to a monogram so the layout never shows a broken image. An operator can
also set their own `https` image per product from the desk, or point it at a file
in `apps/web/public`.

## Production with Compose

```bash
cd ecommerce
cp docker/env.example docker/.env
# edit POSTGRES_PASSWORD, ALLOWED_ORIGINS, COOKIE_SECURE (true behind HTTPS)
docker compose --env-file docker/.env -f docker/docker-compose.yml up -d --build
```

This standalone stack is for development/demo. In a real Duka deployment the
storefront is created and upgraded as part of Duka's own Compose project
(`deploy/ecommerce/compose.shop.yml`, driven by `deploy/go-live.sh` and
`deploy/update.sh`) with a separate hostname, database and backup key.

Services here: `db` (PostgreSQL 17.11, not published), one-shot `migrate`,
`api`, `worker`, `web` (port 3100). Both `api` and `migrate` build from
`docker/Dockerfile` target `api`; `web` uses target `web`. Only `docker` needs
to build the images; nothing is deployed by this repository.

## The storefront's look

The shop borrows its visual language from apple.com — a white page, pale panels,
hairlines instead of borders, one blue accent, a translucent 48px nav, and
display type that carries the page. That skin lives entirely in
`apps/web/app/storefront.css` and every selector is scoped to `.shop-layout`, so
the store desk at `/admin` keeps the ERP design system untouched. Nothing about
the data, routing or server actions changed to make it look that way.

## Design decisions worth knowing

- **Money is a decimal string.** `decimal.js` for arithmetic, `decimal(10,2)` in
  the database, `toMoney()` on the way out. Never a float, never a JS number in
  an API payload.
- **Stock is held, not moved.** Adding to cart creates an `inventory_reservation`
  with a 15-minute TTL. Checkout consumes the hold and decrements stock in the
  same transaction. Cancelling restocks. An expired hold stops counting against
  availability immediately, and the worker closes the expired rows.
- **Checkout is idempotent.** `POST /orders` requires `Idempotency-Key`; a retry
  returns the original order byte-for-byte, and the same key with a different
  body is refused. Refunds behave the same way.
- **Only a provider event can mark an order paid.** Manual mode records a
  confirmed payment by an administrator (audited); webhook mode verifies an HMAC
  signature, stores every event once, and is replay-safe.
- **Three identity realms.** Customer, guest and administrator are separate
  tables, separate cookies and separate permission checks; a customer cookie can
  never reach `/admin/*`.
- **The adapter refuses what the ERP cannot do.** Missing capabilities raise
  `ERP_CONTRACT_UNSUPPORTED` with the contract reference and are never faked.
  Sync jobs for unsupported work go `dead` with a reason instead of retrying.
- **Post-commit side effects.** Provider and ERP calls run after the database
  transaction commits (`afterCommit`), so a rollback cannot strand an external
  charge or an ERP document.
- **Forward-only migrations.** Checksummed; editing an applied file is a hard
  error. Migrations take an advisory lock so two deploys cannot race.

## Scripts

| Command                                  | Purpose                                                       |
| ---------------------------------------- | ------------------------------------------------------------- |
| `npm run dev` / `dev:web` / `dev:worker` | Run API, storefront, worker                                   |
| `npm run typecheck`                      | API + web type check                                          |
| `npm run build` / `build:web`            | Bundle API+worker / build Next                                |
| `npm test`                               | Unit + integration tests (embedded PostgreSQL)                |
| `npm run test:pg-concurrency`            | Real-PostgreSQL concurrency proof (needs `TEST_DATABASE_URL`) |
| `npm run db:migrate` / `db:status`       | Apply / inspect migrations                                    |
| `npm run db:seed`                        | Store settings + first administrator (no sample data)         |
| `npx tsx scripts/api-docs.ts`            | Regenerate `docs/API.md`                                      |
| `npx tsx scripts/erp-inventory.ts`       | Re-inspect the ERP routes read-only                           |

## Honest status

- No ERP write has ever been performed by this project. Phase 1 inspected the
  ERP read-only and implemented against the verified contract.
- The M-Pesa adapter is written but **has not been tested against live Daraja**.
  `PAYMENTS_MODE=manual` is the default and `PAYMENT_CAPTURE_ENABLED=false`.
- Real-PostgreSQL concurrency is proven by a gated test; the default suite uses
  embedded PGlite (single connection), which proves SQL and state machines but
  not multi-connection races.
- Nothing here has been deployed. `docs/OPERATIONS.md` describes how; running it
  is the operator's decision.
