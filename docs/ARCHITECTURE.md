# Architecture and integrity model

## Boundaries

- `apps/web`: responsive Next.js/React client. All browser API requests are relative `/api/v1`. Production pages are dynamic and obtain per-request script nonces through `proxy.ts`. No CDN scripts/fonts are required.
- `apps/api`: Express versioned REST boundary, authenticated database sessions, Zod validation, service-level permissions and transaction orchestration. The client supplies an intention, never authoritative company/user/permissions/prices/totals.
- `packages/shared`: exact Decimal arithmetic, strict request schemas, permissions and state machines; Zod interpreter mode avoids CSP eval probes.
- `packages/accounting`, `packages/inventory`: journal and perpetual weighted-average posting engines. PostgreSQL enforces additional balance, immutable-history, scope and tracking guards.
- PostgreSQL17 is the system of record. No Redis or required paid auth/database service. Provider and mail work is durable in PostgreSQL, not an in-memory success flag.

## Requests and scope

A session token is stored only in an HttpOnly cookie; its SHA256 hash, expiry and revocation are in `sessions`. Actor memberships/permissions are read on the server. Mutations require an allowed Origin plus the session's CSRF secret. Public authentication bodies are16KiB; provider callbacks128KiB; authenticated command bodies8MiB, parsed only AFTER session/CSRF checks.

`transaction()` begins an explicit transaction, sets tenant/user context and timeouts, and supplies `Context.onRollback`. FORCE RLS and scoped FKs prevent cross-tenant references. Branch/warehouse authorization is checked in services; a selected branch narrows GET scopes. Financial authority does not come from URL/body company IDs. GET commands use repeatable-read (some print GETs also append audit entries); period closing uses repeatable-read. Deadlocks/serialization conflicts get bounded retries. The application does not claim to be deadlock-free under every possible interleaving.

Command idempotency is scoped to company/operation/key, canonical request hash and actor. It stores the response, not password/upload request bodies. Row/advisory locks serialize duplicate attempts. Financial posting, document numbering, stock, GL, payments and the idempotent response commit together.

Outstanding helpers lock the immutable parent FIRST, then read child allocations in another statement. Combining lock and sums in one SELECT can retain a pre-wait snapshot; a deterministic blocking PostgreSQL regression covers this. Cash shifts/contact/document/stock locks are acquired in a consistent order where practicable. Outgoing cash payments re-read physical availability while holding the drawer lock.

## Money and stock

Money/value postings round to two currency decimals; quantities/unit costs use six. Decimal precision40 avoids binary floating-point totals. Taxes/prices/units are snapshotted in document lines. Server-side repricing, limits, permissions and stock are rechecked at posting.

Perpetual weighted average records immutable `stock_movements` and a transactional `stock_balances` cache. Negative/oversold stock, invalid serial/batch identity and backdated stock chronology are rejected. Final depletion clears the remaining rounded value. Transfers have paired movements and journals; interbranch clearing preserves branch books. Counts retain expected versions so stale counts cannot silently replace later activity.

Inventory reconciliation FULL JOINs movement totals with the cache and requires all warehouses of every selected branch. Company integrity also checks balanced/nonempty journals, tracking counts, missing operational journals, AR/AP, customer/supplier advances, GRNI unsettled refunds, and operational posted expense net against its GL sources.

## Principal postings

| Event                      | Debit                                                      | Credit                                                     |
| -------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| GRN                        | Inventory/expense                                          | GRNI                                                       |
| Matched supplier invoice   | GRNI, recoverable tax, positive variance                   | AP; negative variance if applicable                        |
| Sale                       | Cash/bank/card/M-Pesa clearing, AR, used customer advances | Revenue and output tax                                     |
| Sale stock issue           | COGS                                                       | Inventory                                                  |
| Customer receipt           | Tender                                                     | AR and/or customer advances                                |
| Supplier payment           | AP and/or supplier advances                                | Tender                                                     |
| Supplier return            | AP                                                         | Stock/expense, input tax and appropriate price variance    |
| Supplier credit offset     | AP target invoice                                          | AP source invoice; same supplier/branch, no cash movement  |
| Supplier credit refunded   | Actual incoming tender                                     | Source AP credit                                           |
| Supplier credit correction | Opposite AP reallocation or actual outgoing repayment      | Corresponding AP/tender; original records remain immutable |
| Expense payment            | Expense and recoverable tax                                | Tender                                                     |
| Expense void (no transfer) | Tender (original payment stays as flagged history)          | Original expense/tax, at the original posting date         |
| Expense reclassification   | New expense account                                        | Original expense account; tax/totals untouched             |
| Asset acquisition (paid)   | Asset and optional recoverable tax                          | Tender; opening assets use equity instead                  |
| Asset depreciation         | Depreciation expense                                       | Accumulated depreciation; exact final remainder            |
| Asset disposal             | Accumulated depreciation, proceeds tender, disposal loss    | Asset cost and disposal gain                               |

Operational documents cannot be undone using a GL-only reversal. Manual/opening journal reversals are append-only. Supplier credit settlements and their reversals have dedicated append-only records, DB overdraw/scope/date guards and unique reversal links. An AP debit balance is not silently rewritten into a supplier advance.

## Files, offline and providers

Receipt bytes are written privately before attachment metadata commits. Normal rollback/retry removes new files; an ambiguous COMMIT preserves bytes because the DB may have committed. Expense + optional receipt metadata is one idempotent command. Downloads require parent authorization and are attachment-only. Signature checks are not malware scanning.

IndexedDB updates use atomic read/write transactions. Captures have durable client IDs and registered operator/branch/warehouse scope. Only constrained walk-in, standard-price cash is accepted offline; online synchronization fully revalidates and reports conflicts. The service worker never caches authenticated API responses. Offline captures/pending tenders/fiscal submissions are not posted or certified sales.

Daraja initiation is separate from verified success. Token-bound callbacks, recorded CheckoutRequestID/provider/amount/phone, independent provider query and receipt deduplication form the boundary. Fiscal dispatch requires an externally approved gateway; no certification is fabricated. Password reset token + mail job commit together, then a lease/backoff worker sends verified-TLS SMTP, expires stale tokens and clears delivered bodies.

## Runtime and operations

`build.ts` bundles local workspace TypeScript to runnable `.mjs` while externalizing installed native/third-party packages. Next standalone output includes public/static files and an explicit application package boundary. Production startup rejects privileged/owning runtime roles and mismatched migrations/RLS.

Use separate migrator (DDL owner, intentionally privileged), runtime (DML + FORCE RLS), SELECT-only BYPASS backup and disposable-database restore roles. Actual host isolation, off-site monitoring and provider onboarding remain operator gates. See BACKUP_RESTORE and KNOWN_GAPS; a balanced local test suite is not statutory or security certification.

Paid expense refunds/repayments are append-only source records, not mutations of the original voucher. They reverse original expense/tax account snapshots, cap cumulative net/VAT/gross, preserve exact final rounding remainder and match real incoming/outgoing tenders. Company integrity includes this operational register; dashboard expense cash spend follows actual payment/refund dates. Pure no-transfer voids keep the expense, its payment row and journals as immutable history, append an exact reversal at the original open date and flip one terminal status; register/shift/dashboard payment sums exclude void-flagged payments. Reclassification journals move posted net only; refund, reclassification and void are mutually exclusive per voucher by DB guard. The fixed-asset register is immutable except the single active → disposed transition. Paid acquisitions bind one exact outgoing tender; disposals recompute cost/accumulation/NBV and gain/loss inside the database, bind incoming proceeds tenders and stop all further depreciation. The workspace viewer uses a guarded standalone demo frontend/partitioned-cookie API mode, separate from normal production deployment.

## Opening-debt subsystem

Migrations019–022 add separate draft/submitted/posted opening batches/items with debt/credit directions, fixed branch cutovers, append-only unused reversals with exact credit withdrawal and scoped receipt/payment/booked-credit allocations. A review posts only AR/AP, customer/supplier advances and opening equity, with exact deferred party-source binding; imported advance credits become real allocatable advance balances and consumed ones make their batch reversal-proof. Operational tables are not fabricated. Journal boundary locks precede company numbering locks in normal debt posting. The DB serializes opening approval against first trade/backdated debt activity. Original due dates determine aging, financial cutover determines recognition, and imported AR naturally participates in the GL-based customer credit limit. Receipts/payments can combine normal/opening targets; allocated advances are not counted as another tender. Scope/available-credit APIs distinguish customer receipt authority from supplier payment authority.

An unused import correction appends at its original cutover in an explicitly open period; unused imported credits are withdrawn by an append-only opening_reversal consumption at the same date. A current-day reversal plus backdated replacement is rejected because it would duplicate historical aging until the reversal date. Applied migration19 was not rewritten: record-alias correction20 and effective-date policy21 are forward migrations. Cross-branch netting and post-allocation correction remain separate open work.
