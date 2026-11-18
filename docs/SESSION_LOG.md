# Working-session summary — Duka ERP / POS (standalone)

## Current state

Duka Business OS is a standalone ERP + POS monorepo:

- **apps/api** — Node/Express REST API (port 4000), versioned, with PostgreSQL 17
- **apps/web** — Next.js frontend (port 3000), ERP + POS user interface
- **packages/** — `@duka/shared`, `@duka/accounting`, `@duka/inventory`
- **database/migrations** — forward-only, checksummed SQL migrations
- **deploy/docker** — Docker Compose stack (PostgreSQL, API, web, proxy, tunnel, ops)
- **deploy/ubuntu** — native systemd units and Caddyfile
- **deploy/cloudflare** — Cloudflare Tunnel Caddyfile

## Integration API (kept)

The following integration endpoints remain in the ERP so a custom UI can be built
to facilitate integration with external ecommerce/payment/fiscal systems:

- `GET /api/v1/integrations/status` — integration mode and readiness
- `GET /api/v1/integrations/config` — masked per-company integration configuration
- `PUT /api/v1/integrations/config` — configure provider credentials / toggle enablement
- `GET /api/v1/integrations/mpesa` — M-Pesa intents and reconciliation state
- `POST /api/v1/integrations/mpesa/intents` — initiate STK Push
- `GET /api/v1/integrations/mpesa/intents/:id` — read confirmed provider status
- `POST /api/v1/integrations/mpesa/intents/:id/mock` — development-only mock provider outcome
- `GET /api/v1/integrations/fiscal` — fiscal failures, identifiers and retry state
- `POST /api/v1/integrations/fiscal/:id/retry` — retry failed fiscal submission
- `GET /api/v1/integrations/mpesa/callback/:token` — provider callback (public mount)

The UI entry point is `/integrations` (IntegrationsPage) in the workspace sidebar.

Adapters: `apps/api/src/integrations/mpesa.ts`, `apps/api/src/integrations/fiscal.ts`,
`apps/api/src/integrations/worker.ts`, `apps/api/src/services/integrations-config.ts`.

## Removed (ecommerce)

The separate `ecommerce/` storefront application and its `deploy/ecommerce/`
overlay have been removed. Duka now deploys as a single ERP + POS stack only.
External storefronts integrate via the integration API above.

## What works out of the box

- Server-side sessions, CSRF, Argon2id, TOTP, password recovery (durable SMTP queue)
- Catalog, products, units, variants, bundles, tax rules, pricing
- POS checkout, split tenders, credit, shifts, cash movements
- Inventory: perpetual weighted-average, stock documents, counts, transfers, batches, serials
- Procurement: POs, GRNs, supplier invoices, AP, supplier returns
- Accounting: double-entry GL, journals, trial balance, P&L, balance sheet, tax, aging
- Expenses, approvals, private receipts, fixed assets, depreciation, disposal
- Opening balances: guided reviewed AR/AP carry-forward
- Offline: constrained cash capture, device authorization, sync with conflict handling
- Integrations: M-Pesa (mock/daraja), eTIMS adapter boundary, config UI

## Deployment

One command on Ubuntu + Docker + Cloudflare Tunnel:

```bash
bash deploy/go-live.sh pos.your-domain.example
```

Or native systemd via `deploy/ubuntu/`. See `docs/DEPLOYMENT.md`.

## Verification

```bash
npm run typecheck
npm test
npm run build             # production Next standalone + bundled .mjs CLIs
bash deploy/self-check.sh <erp-host>
```
