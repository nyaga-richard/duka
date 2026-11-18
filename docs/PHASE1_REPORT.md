# Phase 1 close-out

## Brief

Inspect the Duka ERP read-only, then build an independent e-commerce foundation:
its own database, a typed API, isolated ERP integration, authentication with
roles, automated tests and documentation. Payments stop at the boundary until
the foundation is tested. Report first, then implement with verification.

## Delivered

1. **Inspection (read-only).** `docs/ERP_ENDPOINT_INVENTORY.md` lists every ERP
   endpoint parsed from the source; `docs/ERP_INTEGRATION_CAPABILITY_REPORT.md`
   classifies 27 capabilities (15 verified, 12 unsupported);
   `docs/ERP_INTEGRATION_CONTRACT.md` specifies the 12 gaps (G1–G12) with the
   request/response shape each would need. No ERP write, migration or config
   change was performed at any point.
2. **Independent project.** New TypeScript/Express service under `ecommerce/`
   with its own PostgreSQL schema (6 migrations), decimal money handling,
   NodeNext imports and strict type checking.
3. **Schema.** The approved ERD verbatim (`0001`) plus catalogue extensions
   (`0002`), three identity realms with RBAC (`0003`), commerce tables with
   database-enforced invariants (`0004`), integration/audit/idempotency tables
   (`0005`) and reference data (`0006`).
4. **API.** 49 endpoints (see `docs/API.md`, generated from the route registry):
   catalogue, cart with stock holds, idempotent checkout, orders, reviews,
   payments, provider webhooks, and an admin surface for orders, payments,
   shipments, refunds, ERP sync, audits, customers, catalogue status, review
   moderation and settings.
5. **ERP integration.** Isolated adapter package: single-flight login, CSRF and
   Origin handling, deterministic idempotency keys, retry policy, typed errors,
   refusal of unsupported capabilities, a protocol-faithful fake for tests, and
   pull/push sync with an audit log and a dead-letter state.
6. **Payments boundary.** `manual` by default (capture off), `disabled`, `fake`
   (test-only, rejected in production) and a written but unverified M-Pesa
   adapter. Only a provider event or an audited manual confirmation marks an
   order paid.
7. **Worker.** Hold expiry, heartbeat surfaced in `/health/ready`, periodic
   catalogue/inventory pulls and bounded sync processing.
8. **Storefront + staff UI.** Next.js app with catalogue, product detail, cart,
   checkout, order tracking and a staff page for manual capture and refunds.
9. **Tests.** 87 automated tests over the real HTTP surface and the real schema,
   plus a gated real-PostgreSQL concurrency proof. See `docs/TESTING.md` for the
   exact coverage and the explicit non-coverage.
10. **Deployment.** Dockerfiles and a Compose stack (PostgreSQL, one-shot
    migrate, API, worker, web) with secrets supplied by environment.

## Verification evidence

| Claim                                               | Evidence                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Migrations apply, are idempotent and tamper-evident | `tests/integration/migrations.test.ts`; `npm run db:status`                                            |
| Database invariants are enforced                    | `tests/integration/constraints.test.ts`                                                                |
| Auth, CSRF, realms and RBAC work                    | `tests/integration/auth.test.ts`                                                                       |
| Stock cannot oversell; holds expire                 | `cart.test.ts`, `orders.test.ts` (+ gated PG proof)                                                    |
| Checkout is idempotent and stock-correct            | `orders.test.ts`                                                                                       |
| Only verified events mark an order paid             | `payments-manual.test.ts`, `payments-webhook.test.ts`                                                  |
| ERP adapter handles the real constraints            | `erp-adapter.test.ts`                                                                                  |
| Sync pulls/pushes without duplicates                | `sync.test.ts`, `worker.test.ts`                                                                       |
| The app boots and serves the storefront             | `npm run dev`, `npm run dev:web` (manual smoke: `/health/ready`, `/api/v1/catalog/products`, `/admin`) |

Type checking: `npm run typecheck` (API and web). Build: `npm run build`,
`npm run build:web`.

## Deliberate non-goals / open gaps

- **No ERP writes.** Everything ERP-facing is implemented but exercised only
  against the fake. Live use requires the ERP-side contract items.
- **M-Pesa is unverified.** Code exists; it needs sandbox validation, a public
  callback URL and a decision on refunds (currently refused).
- **Real-PostgreSQL concurrency proof is opt-in** (`TEST_DATABASE_URL`), because
  the sandbox has no PostgreSQL server. It must be run in CI before go-live.
- **Notifications, search, promotions engine, multi-currency and
  multi-warehouse routing** are out of Phase 1.
- **Catalogue authoring is not local.** Products arrive from the ERP; the admin
  API can publish/archive but deliberately cannot invent prices or stock.
- **Nothing is deployed.** This report claims implementation and automated
  verification only.

## Recommended next step

Agree G1/G2 (stock reservation) and G6/G7 (payment and refund by reference) with
the ERP owner, then run the gated PostgreSQL test and the adapter against a
staging ERP with a dedicated integration identity.
