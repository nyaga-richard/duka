# Operations runbook

## Topology

```
browser ──HTTPS──> web (Next, :3100) ──server-side proxy──> api (Express, :4100) ──> PostgreSQL
                                                              │
                                                              └──> worker (holds, ERP sync) ──> ERP HTTP API (only if enabled)
```

- Only `web` (and optionally `api`, if the web app is not used) is published.
- PostgreSQL is never published.
- The ERP is never a datastore for this service; a compromise here cannot write
  to the ERP database.
- The API is the only process that holds ERP credentials and payment keys.

## First deploy

1. Copy `docker/env.example` to `docker/.env`, set `POSTGRES_PASSWORD`,
   `ALLOWED_ORIGINS`, and `COOKIE_SECURE=true` when behind TLS.
2. `docker compose --env-file docker/.env -f docker/docker-compose.yml up -d --build`.

   In a Duka deployment this step is replaced by `bash ../duka/deploy/go-live.sh`
   (create) and `bash ../duka/deploy/update.sh` (upgrade), which run the stack defined
   by `deploy/compose.shop.yml` inside the `duka` Compose project.

3. Confirm: `curl -sf http://localhost:4100/health/ready | jq`.
4. Create the first administrator (once), then unset the bootstrap variables:
   ```bash
   docker compose --env-file docker/.env -f docker/docker-compose.yml run --rm \
     -e ADMIN_BOOTSTRAP_EMAIL=owner@example.com \
     -e ADMIN_BOOTSTRAP_PASSWORD='a-long-unique-password' \
     migrate node dist/seed.mjs
   ```
   The seed only writes store settings and the administrator; it never invents
   catalogue or order data.
5. Sign in at `https://<host>/admin`.

## Duka-managed deployment

In a Duka installation the storefront is not deployed from this directory. It
runs inside the `duka` Compose project as the `shop-*` services, created by
`../duka/deploy/go-live.sh` and upgraded by `../duka/deploy/update.sh` using
`deploy/compose.shop.yml`:

| Thing                  | Value                                                        |
| ---------------------- | ------------------------------------------------------------ |
| database container     | `duka-shop-db-1`, database `ecommerce`, role `shop_app`      |
| application containers | `duka-shop-api-1`, `duka-shop-worker-1`, `duka-shop-web-1`   |
| images                 | `duka-shop-api:<RELEASE>`, `duka-shop-web:<RELEASE>`         |
| config                 | `deploy/.env.shop` (0600)                                    |
| dump key               | `deploy/secrets/shop-backup.key` (separate from Duka's)      |
| public entry           | `https://$SHOP_PUBLIC_HOST` through Caddy on the Duka tunnel |

Day-2 commands (no secrets on the command line):

```bash
bash deploy/shop.sh status
bash deploy/shop.sh logs shop-worker
bash deploy/shop.sh migrate
bash deploy/shop.sh backup        # encrypted + verified
bash deploy/shop.sh restore <file>
```

The ERP API is reachable at `http://api:4000` on the private network. Set
`SHOP_ERP_*` in `.env.shop` to enable read-only catalogue and stock pulls; the
ERP user must not require an interactive MFA challenge. Stock and prices are
read from the ERP and never written back.

Rollback happens through `../duka/deploy/update.sh` (both stacks roll back together if
either health gate fails). Do not restore a storefront dump into Duka's `duka`
database — the schemas and owners are different by design.

## Health

| Endpoint            | Meaning                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /health/live`  | Process is up. No dependency checks.                                                                   |
| `GET /health/ready` | Database reachable, migrations current, worker heartbeat age, payments/ERP mode. `503` when not ready. |

`checks.worker.required` is `false` outside production: a missing worker degrades
hold expiry and ERP retries but does not make the API unready. In production,
alert when `checks.worker.stale` is `true` for more than five minutes.

## Migrations

Forward-only and checksummed.

```bash
npm run db:status      # applied / pending / checksum mismatches
npm run db:migrate     # apply pending migrations
```

Rules:

- Never edit an applied migration; add a new one. The runner refuses to start on
  a checksum mismatch (protects every environment from drift).
- Migrations take a PostgreSQL advisory lock, so concurrent deploys serialise.
- Back up before migrating. There is no down-migration by design.

## Enabling the ERP integration

Follow [`ERP_CONNECTION_GUIDE.md`](ERP_CONNECTION_GUIDE.md). It is the ordered,
copy-pasteable procedure — ERP role and identity, the origin rule, the six
`SHOP_ERP_*` values in `deploy/.env.shop`, the probe, the first
catalogue and stock pulls, one customer and one order document, plus a
symptom→cause table. Read [`ERP_INTEGRATION_CONTRACT.md`](ERP_INTEGRATION_CONTRACT.md)
before promising anything beyond it: those additions (G1–G9) are proposals, and
the guide only uses capabilities the ERP already implements.

In short: create a dedicated ERP identity (never an owner account, never with
MFA enrolled) holding `catalog.read`, `inventory.read`, `customers.read`,
`customers.write` and `documents.write`; set `SHOP_ERP_ENABLED=true`,
`SHOP_ERP_BASE_URL=https://<erp public host>`, `SHOP_ERP_EMAIL`,
`SHOP_ERP_PASSWORD`, `SHOP_ERP_BRANCH_ID` and `SHOP_ERP_WAREHOUSE_ID`; recreate
`shop-api` and `shop-worker` (a restart does not re-read the file); then
`POST /admin/erp/probe`, `POST /admin/sync/pull-catalog`,
`POST /admin/sync/pull-inventory`, and watch `GET /admin/sync/overview`.

Leave `ERP_RESERVE_ORDERS_IN_ERP=false` until the ERP implements a reservation
contract (gap G3): approving a document is a POS-shaped action with no release
path for abandoned carts. Orders are pushed as sales-order documents in `draft`,
which does **not** move ERP stock.

## Payments

- Phase 1 default: `PAYMENTS_MODE=manual`, capture disabled. Staff record
  confirmed cash/bank payments; refunds are recorded and settled outside the
  system.
- `PAYMENTS_MODE=fake` exists for tests only and is rejected in production.
- M-Pesa: set `MPESA_MODE=sandbox` and the Daraja credentials plus
  `MPESA_CALLBACK_SECRET` (32+ chars). The adapter is written but **unverified
  against live Daraja**; validate STK push, callback signature, idempotent
  replay and the refund path (the current code refuses M-Pesa refunds with
  `MPESA_REFUND_UNSUPPORTED`).
- The webhook URL is `POST /api/v1/webhooks/payments/mpesa`. It is exempt from
  CSRF/Origin and authenticated by HMAC; every event is stored before it is
  acted on, duplicates are ignored, and invalid signatures are recorded as
  `ignored` and answered with `401`.

## Routine checks

- `erp_sync_job` rows in `dead` with `last_error` — a contract gap or a data
  problem; nothing retries automatically.
- `payment_webhook` rows with `signature_valid=false` — someone is posting to
  the callback URL with the wrong secret.
- `security_event` for repeated `customer.login_failed`.
- Reservation volume vs. abandoned carts: 15-minute TTL by default
  (`CART_RESERVATION_MINUTES`).
- Backup/restore drills: PostgreSQL logical dump plus the ERP's own backups.

## Incident: ERP down

- Catalogue and inventory reads keep serving the last synced values.
- Checkout still works locally; ERP pushes queue with backoff and then `retry`.
- Do not invent stock or prices. If the queue grows, fix the ERP or stop selling
  at the edge rather than mutating data by hand.

## Incident: payment provider down

- Orders stay `placed` with `payment_status=pending`.
- Webhooks can arrive out of order; the ingest path is idempotent and re-checks
  the transaction state inside a lock, so replaying the same event is safe.
- Manual capture remains available as a documented fallback.
