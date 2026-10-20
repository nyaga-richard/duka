# API/operator integration reference

Base: `/api/v1`; JSON success envelope `{ "data": ..., "meta": { "request_id": ... } }`. Errors contain `error.code`, `message`, optional field details and `request_id`. Amount/quantity values are decimal **strings**, not floating-point numbers. UUIDs and strict schemas reject unknown authoritative fields.

## Authentication

1. POST `/auth/login` with `{email,password,totp?}`. The server sets `duka_session` (HttpOnly, SameSite=Lax; Secure in production) and returns `csrf_token`.
2. GET `/auth/me` to restore actor/session CSRF; GET `/metadata` for authorized business configuration.
3. Mutations require the session cookie, an exact allowed `Origin`, `X-CSRF-Token`, `Content-Type: application/json`, and usually `Idempotency-Key`.
4. POST `/auth/logout`; successful logout/password change/reset revokes appropriate sessions and clears the cookie. TOTP enrollment expires after15 minutes and rejects replay.
5. POST `/auth/forgot-password` is generic and durable, including when SMTP is unavailable. `/auth/reset-password` accepts a single-use expiring token plus a new password of at least12 characters. SMTP delivery is asynchronous, not proof of account existence in the response.

Do not put credentials/tokens in logs, URL examples, analytics or support tickets. Scripts accessing an authenticated API must obey the same Origin/CSRF/idempotency contract; there is no unaudited admin bypass header.

## Representative connected endpoints

| Domain                | Examples                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog               | `/products`, `/products/:id`, `/categories`, `/tax-rules`, units/barcodes/bundles via the runtime registry                                                                                          |
| Checkout              | POST `/pos/price` (quote only), POST `/sales` (actual checkout), GET `/sales/:id`, receipt/PDF routes                                                                                               |
| Sales corrections     | POST `/sales/returns`, GET `/sales/returns/list`; pending refunds via integration routes                                                                                                            |
| Contacts              | `/customers`, `/suppliers`, `/:id/statement`, `/:id/open-items`, `/settlements`, `/advances/apply`                                                                                                  |
| Procurement           | `/purchases/orders`, `/:id/transition`, `/purchases/receipts`, `/purchases/invoices`, `/purchases/returns`                                                                                          |
| Paid supplier credits | POST `/purchases/credits/settle`, POST `/purchases/credits/:id/reverse`; immutable history/current balance on invoice detail                                                                        |
| Stock                 | `/inventory/balances`, `/inventory/movements`, `/inventory/documents`, `/inventory/reconciliation`                                                                                                  |
| Accounting            | `/accounting/journals`, reversal/period endpoints, `/accounting/integrity`, GL-derived reports                                                                                                      |
| Expenses              | POST `/expenses` with optional `{attachment:{filename,mime_type,base64}}`; `/expenses/:id/attachments`; private `/attachments/:id` download                                                         |
| Expense refunds       | GET `/expenses/:id`, POST `/expenses/:id/refunds`, POST `/expenses/refunds/:id/reverse`, `/print/expense-refund/:id`; original account/net/VAT and actual tender direction are server-authoritative |
| Shifts                | `/shifts`, expected counts, submission/review and controlled cash movement routes                                                                                                                   |
| Integrations          | `/integrations/status`, M-Pesa intent/status/callback, fiscal dispatch/retries, authorized external refund settlement                                                                               |
| Offline               | Device authorization, catalog version and explicit sync routes in runtime registry                                                                                                                  |

**Checkout is POST `/sales`, not `/pos/checkout`.** `/health/live` and `/health/ready` are outside `/api/v1`. `/api/v1/docs` lists registered routes and permissions. `/api/v1/openapi.json` is generated from those actual routes/Zod schemas. The OpenAPI endpoint is a useful boundary inventory, not a claim that every response model is fully formalized.

### Supplier credit offset

```json
{
  "kind": "offset",
  "invoice_id": "SOURCE_INVOICE_UUID",
  "target_invoice_id": "OTHER_INVOICE_OF_SAME_SUPPLIER_AND_BRANCH",
  "amount": "50.25",
  "reason": "Apply the paid-return credit against the next invoice"
}
```

For a real refund use `kind:"refund"`, omit target, and provide `payment:{method_id,reference?}` plus `shift_id` for cash. Server caps credit and target outstanding, checks dates/permissions, and calculates all effects. This records a **confirmed incoming** transfer; it does not initiate one. Reversal requires `payments.pay` + `accounting.reverse`; reversing a refund needs an actual outgoing repayment. M-Pesa outgoing repayments are not simulated.

## Retry contract

Use one durable key for one unchanged intention. After timeout/network/5xx, the command may already have committed: **do not create a replacement key**. Retry unchanged to recover the stored response or reconcile the resource with a manager. A later401/403/429 does not disprove an earlier commit. Same key with a changed canonical body returns conflict; keys cannot be replayed by a different actor. Browser recovery keys are actor-scoped fingerprints, not stored request bodies.

Typical statuses:401 unauthenticated,403 permission/scope/CSRF/origin,404 unavailable/invisible record,409 state/stock/over-allocation/period/concurrency conflict,413 transport size,422 schema/reference/financial input,429 rate limit,503 unavailable provider/configuration. Preserve financial intent on uncertain results; reauthenticate before retrying expired sessions.

GET `branch_id` narrows selected-branch scope. Company-wide integrity/closing/bank actions require full location authority. Do not compare partial warehouse stock against a whole-branch GL and call it a discrepancy. Pagination is explicit; contact open-items exclude zero/credit balances before paginating. Never present a single exported page as a complete ledger.

Workspace embedding is explicit isolated-demo transport, not an authentication bypass: distinct HttpOnly/Secure partitioned cookie, ordinary sessions/CSRF/Origin/RBAC still apply. Production rejects `WORKSPACE_PREVIEW`. A successful password response without a retained session now produces actionable UI feedback instead of silently staying on login.

## Positive opening AR/AP carry-forward

- GET `/accounting/opening-metadata?branch_id=...`; GET/POST `/accounting/opening-batches`; GET/PUT `/accounting/opening-batches/:id`.
- POST `/:id/transition` with submitted/draft/cancelled and reason; POST `/:id/post` after review; POST `/:id/reverse` for an unused batch at original cutover only.
- Input: one branch, accounting_date, source reference/notes, items `{kind:"customer"|"supplier",contact_id OR contact_code,reference,original_date?,due_date,amount,description?}`. Amount means positive OUTSTANDING debt. No creator/company/currency/tax/stock fields are accepted.
- Contact `open-items` returns `document_type:"invoice"|"opening"`; settlement and receipt/payment advance allocation entries now accept that discriminator (default invoice for existing clients). Do not guess target type from UUID or create fake operational invoices.
- POST `/accounting/opening-items/:id/apply-credit` consumes a matching already recognized `credit_id`; no tender occurs. GET `/payments/advances` now exposes only positive available credits within the caller's receive/pay authority and optional contact/branch filter.
- `/print/opening-balance/:id` is an authorized ordinary carry-forward schedule, not a fiscal invoice. Original balances feed AR/AP integrity, statements and aging; no turnover/tax/cash appears.

Exact safeguards/scope limits: OPENING_BALANCES. Credits/advance imports and guided post-settlement corrections are not implied by these endpoints.
