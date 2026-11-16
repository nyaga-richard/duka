# E-commerce inside the Duka deployment

The storefront is **part of Duka's own Compose project**, not a second stack an
operator has to remember. `deploy/go-live.sh` creates it, `deploy/update.sh`
upgrades it, and Caddy serves it on a second hostname that shares the same
Cloudflare Tunnel. Nothing in the ERP's behaviour, routes, database or backups
changes.

```
                     Cloudflare
        pos.example.com        shop.example.com
                │                    │
                └──────► proxy:8080 ◄┘        (one tunnel, host-based routing)
                              │
                   ┌──────────┴───────────────┐
                   │                          │
        api:4000  web:3000          shop-api:4100  shop-web:3100
             │         │                  │            │
          db (duka)  uploads        shop-db (ecommerce) │
                   │                          │
                   └── ERP HTTP (read-only) ◄─┘
```

- **Separate database, role, volume, images and backup key.** `shop-db` (service)
  / `duka-shop-db-1` (container) holds database `ecommerce` owned by `shop_app`.
  It never shares Duka's `duka` database, `data` network, `database` volume or
  `duka_backup` dump key.
- **No public ports.** Only `proxy` is exposed (loopback in Tunnel mode). The
  shop API and web app publish nothing.
- **Read-only ERP integration.** The shop calls Duka's API over the private
  `edge` network; it never receives database access, and never writes stock,
  prices or products back.

## What go-live creates

`bash deploy/go-live.sh pos.example.com` now additionally:

1. asks for a storefront hostname (default `shop.<PUBLIC_HOST>`; it must differ
   from the ERP host) and creates `deploy/ecommerce/.env.shop` (mode 0600) plus
   `deploy/ecommerce/secrets/shop-backup.key` — **once**; both are refused on
   re-runs rather than overwritten;
2. asks for the first storefront administrator (email + an independent
   password; the same password as the ERP owner is rejected) and optionally for
   ERP integration credentials for read-only catalogue/stock pulls;
3. builds `duka-shop-api` (api, worker, migrate, seed) and `duka-shop-web`;
4. starts `shop-db`, waits for its health check, applies the shop's six
   forward-only migrations and seeds store settings + the first administrator;
5. starts `shop-api`, `shop-worker`, `shop-web`, and recreates `proxy` so the
   second hostname routes;
6. gates on `duka-shop-api-1` becoming healthy, then prints the extra
   Cloudflare and backup instructions in the post-boot report.

Re-running `go-live.sh` reuses `.env.shop`, skips credential capture, and is
idempotent at every step (migrations are checksummed, seeding an existing
administrator is a no-op).

## Adding the storefront to an existing installation

`update.sh` never invents a `.env.shop`: an ERP-only host stays ERP-only until
an operator deliberately adds the storefront. On the deployed host:

```bash
cd /opt/duka
sudo bash deploy/ecommerce/init-shop-env.sh shop.example.com
sudo bash deploy/ecommerce/shop.sh up
sudo ADMIN_BOOTSTRAP_EMAIL=shop-owner@example.com \
     ADMIN_BOOTSTRAP_PASSWORD='<12+ chars>' \
     bash deploy/ecommerce/shop.sh seed
SHOP_HOST=shop.example.com bash deploy/self-check.sh pos.example.com
# after any Caddyfile change:
sudo bash deploy/ecommerce/shop.sh proxy
# the shop hostname answers with the wrong app or nothing at all:
sudo bash deploy/ecommerce/shop.sh diag
```

`init-shop-env.sh` refuses to overwrite an existing `.env.shop` or backup key,
so this is safe to attempt twice. From then on `update.sh` upgrades both stacks.

## What update upgrades

`bash deploy/update.sh` detects `deploy/ecommerce/.env.shop` automatically:

1. validates the combined stack **including** `compose.shop.yml` and checks that
   `duka-shop-db-1` is healthy before touching anything;
2. takes the ERP backup as before and then an **encrypted, verified** shop dump
   (`shop.sh backup`, separate key, custom format, decrypt + `pg_restore --list`
   verification) — a failed shop dump aborts the upgrade exactly like a failed
   ERP backup (`--skip-backup` opts out of both);
3. tags `duka-shop-api:previous` / `duka-shop-web:previous`;
4. builds the new `RELEASE=`-tagged shop images and applies the shop's
   forward-only migrations;
5. swaps only `shop-api`, `shop-worker`, `shop-web` (and `proxy`, only when its
   configuration changed) — `shop-db` and its volume are never recreated;
6. health-gates on `duka-shop-api-1`; on failure it re-tags `:previous` for
   **both** ERP and shop images, restores the old containers, and fails loudly;
7. runs `self-check.sh` against both hostnames.

Without `.env.shop` every one of those steps is skipped and the ERP upgrade path
behaves exactly as before.

## Operator commands

```bash
# create/reconcile the shop inside the existing duka project
bash deploy/ecommerce/shop.sh up

bash deploy/ecommerce/shop.sh status
bash deploy/ecommerce/shop.sh logs shop-worker
bash deploy/ecommerce/shop.sh migrate
ADMIN_BOOTSTRAP_EMAIL=... ADMIN_BOOTSTRAP_PASSWORD=... bash deploy/ecommerce/shop.sh seed
bash deploy/ecommerce/shop.sh backup
bash deploy/ecommerce/shop.sh restore deploy/ecommerce/backups/shop-20260101T000000Z.dump.enc
bash deploy/ecommerce/shop.sh psql
bash deploy/ecommerce/shop.sh down      # stops api/worker/web, keeps the database volume
```

Raw Compose equivalent (all files must be used consistently):

```bash
docker compose \
  --env-file deploy/docker/.env.production \
  --env-file deploy/ecommerce/.env.shop \
  -p duka \
  -f deploy/docker/compose.yml \
  -f deploy/cloudflare/compose.tunnel.yml \
  -f deploy/ecommerce/compose.shop.yml ps
```

## Cloudflare (required, manual)

Add a **second public hostname** on the same tunnel:

| Hostname | Service |
| --- | --- |
| `pos.example.com` | `http://proxy:8080` |
| `shop.example.com` | `http://proxy:8080` |

Caddy separates them by `Host`. Apply the same cache/Rocket-Loader rules to the
storefront host; do **not** cache `/api/*` or `/health/*`.

## ERP integration (optional, read-only)

Set these in `deploy/ecommerce/.env.shop` and restart `shop-api`/`shop-worker`:

```
SHOP_ERP_ENABLED=true
SHOP_ERP_BASE_URL=http://api:4000
SHOP_ERP_EMAIL=<ERP user>
SHOP_ERP_PASSWORD=<that user's password>
SHOP_ERP_BRANCH_ID=<optional>
SHOP_ERP_WAREHOUSE_ID=<optional>
```

- The shop presents the ERP's own origin (`ERP_ALLOWED_ORIGIN`) because the calls
  are server-to-server; Duka's origin allowlist is not widened.
- The ERP user must be able to log in **without an interactive MFA challenge**.
  If your ERP enforces MFA for every login, integration cannot start — that is a
  configuration decision on the ERP side, not something this module can bypass.
- The catalogue is empty until an operator triggers a pull. Stock and prices are
  read from the ERP; the shop refuses to push them back.
- Phase 1 honesty boundary: no live payment provider, no automatic capture, no
  ERP writes. A payment must be captured deliberately.

## Backups and restore

| Data | Command | Key |
| --- | --- | --- |
| ERP database + uploads | `dc --profile ops run --rm ops artifacts/server/backup.mjs` | `deploy/docker/secrets/backup.key` |
| Shop database | `bash deploy/ecommerce/shop.sh backup` | `deploy/ecommerce/secrets/shop-backup.key` |

Both keys are separate on purpose: losing or leaking one must never expose the
other. Store both offline, and store a restore rehearsal result, not just a
dump. The shop dump is a PostgreSQL custom-format archive (encrypted with
AES-256-CBC/PBKDF2); restore with the `shop.sh restore` command above, never
into Duka's `duka` database.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `SHOP_PUBLIC_HOST is required` from Compose | the overlay was loaded without `--env-file deploy/ecommerce/.env.shop` |
| Storefront host resolves to the ERP app | Cloudflare hostname still points at the ERP route, or Caddy was not recreated (`dc up -d proxy`) |
| Storefront host still returns **JSON** `NOT_FOUND` after `shop.sh proxy` | run `shop.sh diag`: it compares the Caddyfile on the host with the one mounted in the proxy (sha256), prints the compiled `:8080` routes in evaluation order, asks `shop-web:3100/` directly, and shows the tunnel container |
| Storefront host returns **JSON** `{"error":{"code":"NOT_FOUND"…}}` with `application/json` | Caddy is sending that hostname to the **API**, not to `shop-web:3100` — usually a stale compiled config: the Caddyfile on disk is right, the running container is not. Confirm with `curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: shop.example.com' http://127.0.0.1:8080/api/v1/catalog/products` (200 = shop-api answered) and `docker logs duka-shop-api-1 --tail 5` (a `GET /` 404). Fix with `bash deploy/ecommerce/shop.sh proxy`; `docker restart duka-proxy-1` alone can leave the old config |
| `duka-shop-api-1` unhealthy | `shop.sh logs shop-api`; typical causes are a missing `.env.shop` database URL, `NODE_ENV=production` with a bad URL, or migrations not applied |
| `shop-migrate` fails | forward-only migrations are checksummed; never edit an applied file — add a new migration |
| `update.sh` says "configured but its database container does not exist yet" | `.env.shop` exists but `shop.sh up` never completed. The ERP upgrade proceeds without touching the shop; finish the storefront with `shop.sh up` (it is safe to re-run) |
| image build fails in `next build` with `Cannot read properties of null (reading 'useContext')` | the Next build ran under a non-production `NODE_ENV`. The Dockerfile pins `NODE_ENV=production` for `next build`; if you edited it, put that back |
| Empty catalogue | ERP integration disabled, or no catalogue pull has been run |
| `self-check` storefront checks fail | the hostname is not bound in Cloudflare, or `SHOP_HOST` was not passed (`bash deploy/self-check.sh <erp-host> <shop-host>`; with no host it prints usage and exits 2) |
| storefront returns Cloudflare **530 / 52x** | Cloudflare cannot reach the origin: the public hostname is missing from the tunnel (or its DNS record was created by hand without a tunnel entry). `self-check.sh` first probes the loopback proxy listener (`127.0.0.1:8080`) with the storefront `Host` header, so an "ok … loopback proxy" line proves Caddy and the app are fine and the fault is Cloudflare-side |

## What is NOT proven here

- No Docker Engine, Cloudflare account or public DNS was available in this
  environment, so the overlay has **not** been executed: no `docker compose
  config`, image build, container boot, tunnel route or upgrade was run. The
  files were validated statically (YAML parse, shell syntax, service-reference
  and path checks) only.
- The shop's real-PostgreSQL migration/seed path is exercised by the module's
  own test suite against PGlite; the production PostgreSQL path remains
  host-acceptance work.
- No payment provider, MFA-bypassing ERP login or ERP write path is claimed.
