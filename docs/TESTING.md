# Reproducible local verification

Use Node24.22.0/npm10.8.2/PostgreSQL17. Exact latest execution counts/times are in VERIFICATION and `artifacts/verification/`; passing local tests do not certify a live deployment.

## Database safety first

Set `TEST_DATABASE_URL` to a separate database ending `_test`, owned by an ordinary non-superuser/non-BYPASS development test role. Never use live production URLs/credentials. Tests create isolated companies/documents rather than truncating the business schema; authentication fixtures reset only known test IP rate buckets. Some tests deliberately probe financial guards in transactions that roll back or use explicit auditable reversals.

`npm test` and `test:integration` preload `scripts/test-env.ts` BEFORE any application pool can initialize. The integration helper verifies both configured pool URL and `current_database()` BEFORE migrations/fixtures. This fixes an actual import-order hazard found during development. Do not bypass the guarded scripts by rearranging imports/directly invoking arbitrary tests against the default DB. E2E fixtures verify the physical DB independently.

```bash
npm ci
npm run typecheck
npm test
npm run test:unit          # pure domain/backup crypto checks; no integration DB writes
npm run test:integration
```

Unit/integration coverage includes exact pricing/tax/stock rules; RLS/scoped FKs; immutable/balanced/SAVEPOINT journals; concurrency/oversell; AR/AP/advances/GRNI/returns; approval/bank/asset boundaries; authentication/reset/MFA/CSRF/origins/body limits; cost privacy and positive owner view; atomic private receipt replay/download plus fault after disk write; persistent rates/SMTP queue outage behavior; full reconciliation/missing cache/scope; supplier-credit offsets/refunds/reversals/races/raw multirow guard; parent-lock child-snapshot regression; company-timezone reporting; authoritative cancellation/tombstones/delayed old writer; offline target membership/original-shift conflicts; required fiscal-mode fail-closed behavior.

## Browser suite

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

One Chromium worker; dedicated API4100 and frontend3100; `_test` DB; no reuse of unknown servers. Default builds a **production standalone frontend** in a separate cache directory and runs a development API with explicitly fake providers/test fixtures. This exercises production nonce CSP and UI, NOT live production payment credentials. Browser/page errors and CSP violations are checked across tabs.

Workflows: split tender with genuinely lost committed response/reload/429 retry/receipt failure; pending/confirmed independent mock M-Pesa; PO approval→partial GRN→invoice; two-tab unposted offline cash plus close guard/sync; capped paid return; approved reserved order reload/checkout; atomic expense/receipt recovery;390px mobile navigation/overflow/checkout; paid supplier credit allocation/reversal/refund; warehouse/type/late-response count snapshots; safe unposted cancellation + delayed original packet rejection.

`E2E_WEB_MODE=development` is an optional diagnostic dev-server run. Running multiple development servers plus browsers exhausted this2GiB sandbox and caused timeouts; the production-standalone test runner avoids that overhead. `E2E_REUSE_BUILD=true` is only for an explicitly unchanged diagnostic build, never a default CI/release assumption. Traces/screenshots stay under artifacts and must not be collected from real production users without a privacy process.

## Production-config smoke

```bash
DEMO_MODE=false API_INTERNAL_URL=http://127.0.0.1:4200 npm run build
DOTENV_CONFIG_PATH=/private/isolated-qa.env npm run test:production
```

The QA file supplies a NON-OWNING runtime `DATABASE_URL` ending `_test`; optional `TEST_DATABASE_URL` is a separate owner connection to the same isolated DB for deliberate owner-role rejection. Provision/grant those roles explicitly (see deployment role model). OpenSSL and installed Chromium are required; ports3200/4200 must be free.

The finite test starts bundled API + portable standalone web behind local HTTPS, verifies Secure/HttpOnly cookies/CSRF/nonce hydration, rejects mocks/migration mismatch/privileged owner, and actually sends reset mail to a certificate-verified local TLS SMTP sink, uses its link and checks old-session revocation. It also checks malformed credential-bearing URL errors do not expose secret markers. Test-only certificates/servers are cleaned up. **This is not public TLS/domain/mailbox delivery, live Daraja/eTIMS or Docker execution.**

## Operations and release

- `npm audit --omit=dev` concerns npm production dependencies only.
- Caddy adapt/validate, actual proxy-error token/header redaction and Compose config parsing have run; image/container/host deployment is still untested.
- Follow BACKUP_RESTORE for encrypted snapshot + isolated restore proof; do not equate creating a dump with successful recovery.
- `npm run format:check`, clean Git checkpoint, then `npm run release` for a source-only ZIP + SHA256 manifest. It excludes secrets/data/dependencies/builds and refuses dirty source/overwriting archives by default.

Missing independent checks include full endpoint/CSV authorization audit, malicious-file parsing/scanning, broader cross-browser/accessibility coverage, actual-host load/fault/storage/monitoring/off-site recovery and legal/accountant/provider acceptance. See KNOWN_GAPS.

## Login/refund continuation

Current tests add actual cross-site iframe session retention/logout, distinct preview cookies and unchanged production policy, missing-browser-session UI feedback, and paid-expense refund/repayment/account-snapshot/rounding/race/multirow/approval/period/cash/PDF checks. `npm run test:workspace-login` requires the isolated login-enabled workspace frontend/API already running, with OpenSSL/Chromium installed. It performs no password change or financial posting. The full source suite is now53 tests plus13 Chromium workflows; the separate iframe smoke is additional, not double-counted.

## Opening-debt continuation

The suite is now58 tests plus14 browser workflows. The new cases prove no turnover/tax/stock/cash on opening approval; original-date aging/credit limits; partial receipt/payment and booked-credit settlement; unchanged source hashes; maker/checker/gross limits; duplicate and fixed-date guards; exact deferred AR/AP/equity source binding; operational supplier-reference collisions; last-debt and first-trade/cutover races. Forward policy21 adds an explicit regression that unused reversal/replacement does NOT double historical aging. A privacy regression verifies receivables-only and payables-only users cannot inspect each other's advance balances. The browser uses the actual draft/review/post/settle/apply-credit/PDF UI, not disconnected mocks.
