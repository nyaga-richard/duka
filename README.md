# Duka Business OS

A connected POS and ERP-lite monorepo: **Next.js / React / TypeScript**, a versioned **Node/Express REST API**, and **PostgreSQL 17**. Financial and stock commands post transactionally to auditable subledgers and a double-entry general ledger. No Redis or paid database/auth service is required.

**Status — 18 October 2026:** substantial, locally tested implementation; **not an assertion of production readiness, public deployment, tax certification or live payment verification**. Read the requirement-by-requirement [acceptance checklist](docs/ACCEPTANCE.md), [verification record](docs/VERIFICATION.md) and [remaining gaps](docs/KNOWN_GAPS.md) before operating a real business.

## What is connected

- Server-side sessions, CSRF, Argon2id, TOTP, expiring password recovery with a durable SMTP queue, configurable roles, branch/warehouse membership and audit trails.
- Catalog, unit conversions, variants, bundles, inclusive/exclusive/versioned tax rules and controlled prices/discounts. Cashier API responses redact costs and restricted dashboard totals.
- Checkout, split tenders, credit limits, customer receipts/advances/allocations, shifts, cash movements, approved order fulfilment and controlled sales returns/refunds.
- Perpetual weighted-average inventory, concurrency/oversell protection, stock documents/counts/transfers, reservations, batch/expiry and serial tracking.
- Purchase orders → partial GRNs → supplier invoices/price variance → payment/allocation, AP/GRNI and supplier returns.
- Quotations, proformas, requisitions, delivery-note snapshots, PDFs and CSV reports; expenses/approval/payment with atomic private receipt attachments.
- Guided positive legacy AR/AP carry-forward batches (no fake turnover/tax/stock/cash), reviewed cutover, real settlement/advance allocation and unused-only append-only correction. See [OPENING_BALANCES](docs/OPENING_BALANCES.md).
- Balanced immutable journals, controlled manual reversals, period locks, trial balance, P&L, balance sheet, tax summaries, statements/aging and source-based cash movements. Company-wide closing checks inventory and six financial control accounts.
- Restricted warm-session offline **cash captures**, device authorization, durable IndexedDB queue, server revalidation/conflicts and idempotent sync. A capture is **not** a sale until accepted by the server.
- Explicit mock/Daraja payment boundary and disabled-by-default fiscal adapter boundary. **An STK prompt is not payment; an ordinary receipt is not a certified KRA invoice.**
- Production bundles/standalone frontend, nonce CSP, role/migration readiness checks, encrypted snapshot-consistent DB + attachment backup and disposable restore verification.

## Workspace login (Arena preview)

The live workspace is restored and login-enabled. Click **Use demo account**, then **Sign in to workspace**: `owner@duka.test` / `DukaDemo2026!`. These are public isolated-demo credentials, never production credentials. Embedded login/reload/logout is browser-tested with secure partitioned cookies; normal production cookies remain strict. See [WORKSPACE_LOGIN](docs/WORKSPACE_LOGIN.md).

## Local development

Use **Node 24.22.0** (tested), npm 10.8.2, PostgreSQL 17 and a normal non-superuser/non-BYPASSRLS development DB role. Node 20 is no longer the supported production runtime. Dependencies are exact-pinned in `package-lock.json`.

```bash
npm ci
cp .env.example .env       # edit your own DB URLs; never copy production secrets
npm run db:migrate        # explicit checksummed migrations, no seed
# Explicitly provision a new business; use a secret prompt, not a password in history:
read -rsp 'Initial owner password: ' SETUP_PASSWORD; echo
export SETUP_PASSWORD
SETUP_COMPANY='Your business' SETUP_EMAIL='owner@yourdomain.example' npm run db:setup
unset SETUP_PASSWORD
npm run dev
# For the isolated Arena viewer, use the guarded stable workspace commands in
# docs/WORKSPACE_LOGIN.md instead of relying on a hot-reload WebSocket.
```

Development UI: port3000; API: port4000. Open the preview in a top-level browser tab if an embedded viewer blocks SameSite session cookies. Browser requests use relative `/api/v1` URLs. `/health/ready` checks migrations, FORCE RLS and runtime privileges. Development uses a separate build directory from production output.

**Optional demo only:** on a disposable, non-production database set `DEMO_MODE=true`, `MPESA_MODE=mock`, then run `npm run db:demo`. It refuses production and will not reseed an existing owner. Demo accounts `owner@duka.test`, `manager@duka.test`, `cashier@duka.test` use **DukaDemo2026!**. They are intentionally public test credentials, never suitable for a live database.

## Verify

```bash
# TEST_DATABASE_URL must be a separate database whose name ends in _test.
npm run typecheck
npm test                         # guarded preload before application pools exist
npx playwright install --with-deps chromium
npm run test:e2e                  # isolated ports 3100/4100; fake providers only
npm audit --omit=dev
DEMO_MODE=false npm run build     # production Next standalone + bundled .mjs CLIs
npm run db:reconcile              # authorized operator, all branches/warehouses
# npm run verify runs the guarded local typecheck/tests/audit/build/E2E pipeline.
```

`npm run test:production` is a separate, guarded **local** HTTPS/SMTP smoke test. It requires built artifacts and an independently provisioned non-owning runtime role connected to an isolated `_test` DB, plus OpenSSL/Chromium. It never constitutes a public deployment or real email-provider test. See [TESTING](docs/TESTING.md).

## Production packaging and operations

**One command to a live environment (Ubuntu + Docker + Cloudflare Tunnel):**

```bash
bash deploy/go-live.sh pos.your-domain.example
```

It validates Docker/Compose, generates self-protected secrets once, captures the tunnel token and first-owner credentials without shell-history leakage, builds the pinned images, migrates the schema with the dedicated role, provisions the first business, and starts API + web + loopback Caddy + the outbound-only tunnel (no public inbound ports). Fully unattended runs can pre-export `PUBLIC_HOST`, `TUNNEL_TOKEN`, `SETUP_COMPANY`, `SETUP_EMAIL`, `SETUP_PASSWORD` and `SMTP_URL`. The playbook is [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md); host acceptance gates still apply.

`npm run build` generates `artifacts/server/{api,migrate,setup,reconcile,backup,unpack-backup,restore-test}.mjs` and a portable standalone frontend at `artifacts/web/`. Workspace TypeScript is bundled; installed third-party/native dependencies remain external. Generated build/dependency directories are not source deliverables and must be rebuilt after a clean checkout.

- [DEPLOYMENT](docs/DEPLOYMENT.md): Docker, separate database roles, Ubuntu/systemd, Caddy and optional Cloudflare Tunnel.
- [BACKUP_RESTORE](docs/BACKUP_RESTORE.md): encryption keys, consistent snapshots, actual restore evidence, off-site copies and safe recovery.
- [OPERATOR_GUIDE](docs/OPERATOR_GUIDE.md): setup, opening balances, approvals, reconciliations and day-end operation.
- [USER_GUIDE](docs/USER_GUIDE.md): cashiers, purchasing, returns and offline conflicts.
- [API](docs/API.md), runtime `/api/v1/docs`, `/api/v1/openapi.json`.
- [SECURITY](docs/SECURITY.md), [ARCHITECTURE](docs/ARCHITECTURE.md), [INTEGRATIONS](docs/INTEGRATIONS.md).

**Do not expose DB/API/private storage directly.** Real deployment still needs the operator's host/domain, verified TLS SMTP relay, protected keys, off-site destination, restore rehearsal on that host and acceptance sign-off. Daraja credentials/merchant verification and certified KRA integration are separate external prerequisites.
