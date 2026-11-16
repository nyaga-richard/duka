# ERP endpoint inventory (generated)

Generated from `/home/user/duka/apps/api/src/routes/index.ts` by `scripts/erp-inventory.ts`.
**156 registered `endpoint()` calls.**

These are the routes the ERP registers at runtime through the `endpoint()` helper in apps/api/src/http.ts.
All are mounted under `/api/v1`; `/health/live`, `/health/ready`,
`/api/v1/openapi.json` and `/api/v1/docs` live in `apps/api/src/app.ts`.

```
| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/auth/me` | authenticated / service-checked | Current server-side identity and security token |
| POST | `/auth/logout` | authenticated / service-checked | Revoke current session |
| POST | `/auth/change-password` | authenticated / service-checked | Change password and revoke sessions |
| POST | `/auth/mfa/setup` | authenticated / service-checked | Provision TOTP after password verification |
| POST | `/auth/mfa/enable` | authenticated / service-checked | Enable authenticator MFA |
| POST | `/auth/mfa/disable` | authenticated / service-checked | Disable MFA with password and current code |
| GET | `/auth/sessions` | authenticated / service-checked | List own sessions |
| POST | `/auth/sessions/:id/revoke` | authenticated / service-checked | Revoke an owned session |
| GET | `/metadata` | authenticated / service-checked | Authorized organization and catalog configuration |
| GET | `/dashboard` | `dashboard.read` | Authoritative branch dashboard |
| GET | `/products` | `catalog.read` | Search paginated catalog and barcode aliases |
| POST | `/products` | `catalog.write` | Create a product |
| PUT | `/products/:id` | `catalog.write` | Update product with immutable history guards |
| GET | `/products/:id` | `catalog.read` | Product details and units |
| POST | `/products/:id/units` | `catalog.write` | Configure a selling or purchase unit conversion |
| POST | `/products/:id/barcodes` | `catalog.write` | Add an additional unique barcode |
| POST | `/products/:id/components` | `catalog.write` | Configure non-nested stock bundle recipe |
| POST | `/products/import` | `catalog.write` | Atomic validated bulk catalog import |
| POST | `/products/bulk-prices` | `catalog.write` | Audited atomic bulk price update with queryable change tracking |
| GET | `/price-changes` | `catalog.read` | Queryable selling price change ledger |
| POST | `/prices` | `catalog.write` | Set quantity-tier list/customer/supplier pricing |
| GET | `base` *(computed)* | `perm + ".read"` | `Search ${kind}s` |
| POST | `base` *(computed)* | `perm + ".write"` | `Create ${kind}` |
| PUT | `base + "/:id"` *(computed)* | `perm + ".write"` | `Update ${kind}` |
| GET | `base + "/:id/statement"` *(computed)* | `perm + ".read"` | `Ledger-backed ${kind} statement` |
| POST | `base + "/settlements"` *(computed)* | `kind === "customer" ? "payments.receive" : "payments.pay"` | `Post and allocate ${kind} payment` |
| POST | `base + "/advances/apply"` *(computed)* | `kind === "customer" ? "payments.receive" : "payments.pay"` | `Apply a remaining ${kind} advance` |
| POST | `/pos/price` | `sales.create` | Recalculate a cart on the server without posting |
| POST | `/sales` | `sales.create` | Post atomic checkout, stock, tenders and balanced journal |
| GET | `/sales` | `sales.read` | Search posted sales |
| GET | `/sales/:id` | `sales.read` | Invoice, tender, stock cost and fiscal state |
| GET | `/sales/:id/receipt` | `sales.read` | Audited A4 or thermal PDF; fiscal state is explicit |
| POST | `/sales/returns` | `sales.return` | Post capped partial return, stock disposition and refund |
| GET | `/sales/returns/list` | `sales.read` | Paginated returns and credit notes |
| GET | `/pos/suspended` | `sales.create` | Owned saved carts |
| POST | `/pos/suspended` | `sales.create` | Save a cart without posting stock or money |
| DELETE | `/pos/suspended/:id` | `sales.create` | Remove an owned saved cart after resuming |
| GET | `/shifts` | authenticated / service-checked | Cashier shifts visible to their owner or manager |
| POST | `/shifts/open` | `shifts.open` | Open a till with counted float |
| GET | `/routes` | `routes.read` | Routes with salesperson, till and outstanding balance |
| POST | `/routes` | `routes.manage` | Create a van-sales route |
| PUT | `/routes/:id` | `routes.manage` | Update route assignment |
| GET | `/staff/picklist` | `routes.manage` | Active staff for route assignment picklists |
| GET | `/routes/:id` | `routes.read` | Route detail with its exclusive customers |
| GET | `/routes/:id/ledger` | `routes.read` | Per-customer running ledger across route activity |
| GET | `/route-shifts` | `routes.read` | Route shifts with invoice totals |
| POST | `/route-shifts/open` | `routes.shift` | Open the route van shift on its assigned till |
| GET | `/route-shifts/:id` | `routes.read` | Route shift detail with invoices and balances |
| POST | `/route-shifts/:id/close` | `routes.shift` | Close the route shift and freeze its day |
| GET | `/route-shifts/:id/loading-sheet` | `routes.read` | Consolidated goods-invoiced sheet for the shift |
| GET | `/route-shifts/:id/delivery-sheet` | `routes.read` | Per-customer delivery sheet with invoice amounts |
| GET | `/shifts/:id` | authenticated / service-checked | Expected balances by payment method |
| POST | `/shifts/:id/close` | `shifts.open` | Submit denomination count and reconciliation |
| POST | `/shifts/:id/review` | `shifts.review` | Review cashier reconciliation and post cash variance |
| POST | `/shifts/cash-movements` | `shifts.manage` | Audited cash-in/out, petty cash or bank transfer |
| GET | `/inventory/balances` | `inventory.read` | Available stock and moving weighted-average value |
| GET | `/inventory/movements` | `inventory.read` | Append-only stock ledger |
| POST | `/inventory/documents` | authenticated / service-checked | Opening, adjustment, transfer or optimistic count |
| GET | `/accounting/integrity` | `accounting.read` | Company-wide subledger, stock, journal and tracking integrity |
| GET | `/inventory/reconciliation` | `accounting.read` | Reconcile balance cache, movements and inventory GL |
| GET | `/inventory/batches` | `inventory.read` | Batch quantities and expiry alerts |
| GET | `/inventory/serials` | `inventory.read` | Serial-number availability |
| POST | `/purchases/orders` | `purchases.create` | Create a purchase order |
| GET | `/purchases/orders` | `purchases.read` | Search purchase orders |
| GET | `/purchases/orders/:id` | `purchases.read` | PO lines and partial delivery progress |
| POST | `/purchases/orders/:id/transition` | authenticated / service-checked | Submit, approve, reject or close a PO |
| POST | `/purchases/receipts` | `purchases.receive` | Receive accepted goods and accrue GRNI |
| GET | `/purchases/receipts` | `purchases.read` | Search goods receipts |
| GET | `/purchases/receipts/:id` | `purchases.read` | GRN lines for invoice matching |
| POST | `/purchases/invoices` | `purchases.create` | Recognize matched invoice, input tax and AP |
| GET | `/purchases/invoices` | `purchases.read` | Outstanding supplier invoices |
| POST | `/purchases/returns` | `purchases.create` | Supplier return with stock and liability credit |
| GET | `/documents` | `documents.write` | Quotations, orders, delivery notes and requisitions |
| POST | `/documents` | `documents.write` | Server-priced commercial document |
| GET | `/documents/:id` | `documents.write` | Read a scoped commercial document |
| POST | `/documents/:id/transition` | `documents.write` | Document approval and stock reservation |
| POST | `/documents/:id/to-purchase-order` | `purchases.create` | Convert approved requisition into linked PO |
| GET | `/print/:kind/:id` | authenticated / service-checked | Audited printable business document |
| GET | `/expenses` | `expenses.read` | Expense requests and posted vouchers |
| POST | `/expenses` | `expenses.create` | Request expense and optional private receipt atomically |
| POST | `/expenses/:id/review` | `expenses.approve` | Approve within configured authority limit |
| POST | `/expenses/:id/pay` | `expenses.pay` | Pay approved expense and post journal |
| POST | `/expenses/:id/void` | `expenses.approve` | Void an erroneous no-transfer expense posting at its original date |
| POST | `/expenses/:id/reclassify` | `expenses.approve` | Reclassify a posted expense between expense accounts |
| GET | `/accounting/accounts` | `accounting.read` | Chart of accounts |
| POST | `/accounting/accounts` | `accounting.post` | Create a configurable non-system account |
| GET | `/accounting/journals` | `accounting.read` | Immutable journal listing with reversal state |
| GET | `/accounting/journals/:id` | `accounting.read` | Journal debit/credit detail |
| POST | `/accounting/journals` | `accounting.post` | Balanced manual journal; operational control accounts are protected |
| POST | `/accounting/journals/:id/reverse` | `accounting.reverse` | Reverse eligible manual/opening journal without deletion |
| POST | `/accounting/periods` | `accounting.close` | Create a non-overlapping operating period |
| POST | `/accounting/periods/:id/status` | `accounting.close` | Close or explicitly reopen an accounting period |
| GET | `/accounting/assets` | `accounting.read` | Fixed assets and accumulated depreciation |
| POST | `/accounting/assets` | `accounting.post` | Register a fixed asset: opening against equity or paid with a real tender |
| POST | `/accounting/assets/:id/dispose` | `accounting.post` | Dispose of a fixed asset with exact book removal and gain/loss posting |
| POST | `/accounting/assets/:id/depreciate` | `accounting.post` | Post straight-line monthly depreciation exactly once |
| POST | `/accounting/budgets` | `accounting.post` | Set branch/account/period budget |
| POST | `/accounting/bank-reconciliations` | `accounting.post` | Match bank ledger lines to a confirmed statement balance |
| GET | `/reports/:name` | `reports.read` | Filtered ledger-derived financial and trading report |
| GET | `/payments` | `reports.read` | Confirmed immutable tender register |
| GET | `/payments/advances` | authenticated / service-checked | Unapplied customer and supplier credits |
| GET | `/payments/refunds` | `sales.refund` | Pending external refund settlements |
| POST | `/payments/refunds/:id/confirm` | `payments.pay` | Record independently reconciled external refund settlement |
| POST | `/integrations/mpesa/intents` | `sales.create` | Initiate STK Push; result remains pending |
| GET | `/integrations/mpesa/intents/:id` | `sales.create` | Read confirmed provider status without credentials |
| POST | `/integrations/mpesa/intents/:id/mock` | `sales.create` | Development-only mock provider outcome |
| GET | `/integrations/fiscal` | `integrations.manage` | Fiscal failures, identifiers and retry state |
| POST | `/integrations/fiscal/:id/retry` | `integrations.manage` | Retry failed fiscal submission explicitly |
| GET | `/offline/catalog-version` | `sales.create` | Version token for conflict-aware offline capture |
| POST | `/offline/devices` | `["offline.manage", "sales.price_override"]` | Explicitly authorize a cash-only offline capture device |
| GET | `/offline/devices` | `sales.create` | Owned offline device authorizations |
| POST | `/offline/devices/:id/revoke` | `["offline.manage", "sales.price_override"]` | Revoke an offline device |
| POST | `/offline/sync` | `sales.create` | Synchronize local cash capture, or persist a visible conflict |
| GET | `/offline/sync` | `sales.create` | Owned posted and conflicted client transactions |
| GET | `/users` | `users.manage` | User access and activation state |
| POST | `/users` | `users.manage` | Create a user with scoped, non-escalating permissions |
| POST | `/users/:id/access` | `users.manage` | Change user roles, locations and activation; revoke sessions |
| POST | `/roles` | `users.manage` | Create configurable permission role |
| PUT | `/roles/:id` | `users.manage` | Modify a role without self-escalation |
| PUT | `/settings/company` | `settings.manage` | Update business, tax registration and safe operating controls |
| GET | `/setup/status` | `settings.manage` | First-run readiness across business, receipt, accounting, payments, catalog, inventory and openings |
| POST | `"/settings/" + name` *(computed)* | `settings.manage` | "Configure " + name |
| GET | `/audit` | `audits.read` | Append-only audit trail scoped to assigned branches |
| GET | `/security/events` | `users.manage` | Security and session event log |
| POST | `/attachments` | authenticated / service-checked | Validated private receipt or product attachment |
| GET | `/expenses/:id/attachments` | `expenses.read` | Private receipt metadata for an authorized expense |
| GET | `/attachments/:id` | authenticated / service-checked | Authorized private file download |
| GET | `/pos/products/:id/availability` | `sales.create` | Assigned-location batches, serials and stock version for checkout |
| GET | `/catalog/export` | `catalog.read` | Export a bounded catalog page as Excel-compatible CSV |
| GET | `"/" + kind + "s/:id/open-items"` *(computed)* | `kind === "customer" ? "customers.read" : "suppliers.read"` | Outstanding invoices for explicit payment allocation |
| GET | `/purchases/invoices/:id` | `purchases.read` | Supplier invoice with GRN match and return quantities |
| GET | `/inventory/documents` | `inventory.read` | Audited stock documents and counts |
| GET | `/integrations/config` | `integrations.manage` | Masked per-company integration configuration state (values never returned) |
| PUT | `/integrations/config` | `integrations.manage` | Configure provider credentials or toggle enablement; secrets write-only |
| GET | `/integrations/status` | `integrations.manage` | Integration mode and configuration readiness without secrets |
| GET | `/integrations/mpesa` | `integrations.manage` | Mobile money intents and reconciliation state |
| GET | `/products/:id/attachments` | `catalog.read` | Private product image and attachment references |
| GET | `/accounting/bank-reconciliations` | `accounting.read` | Company-wide confirmed bank statement matches |
| GET | `/accounting/bank-unmatched` | `accounting.read` | Paginated unmatched company-wide bank ledger lines |
| GET | `/accounting/budgets` | `accounting.read` | Branch budget versus posted expense activity |
| GET | `/pos/orders/:id` | `sales.create` | Load approved reserved order for POS fulfilment |
| POST | `/purchases/credits/settle` | `payments.pay` | Apply an available supplier credit to another invoice or record its actual incoming refund |
| POST | `/purchases/credits/:id/reverse` | `payments.pay` | Reverse a supplier credit allocation/refund through an append-only correction |
| POST | `/sales/recovery/cancel` | `sales.create` | Recover an already posted checkout, or persist a permanent cancellation tombstone for an unposted intention |
| GET | `/expenses/:id` | `expenses.read` | Expense original voucher, actual posting date and immutable refund/repayment history |
| POST | `/expenses/:id/refunds` | `expenses.pay` | Record an actually received expense refund against original posted net/tax snapshots |
| POST | `/expenses/refunds/:id/reverse` | `expenses.pay` | Record actual outgoing repayment of an expense refund; no external transfer is cancelled |
| GET | `/accounting/opening-metadata` | `accounting.read` | Fixed branch cutover and earliest debt activity, without inventing operational invoices |
| GET | `/accounting/opening-batches` | `accounting.read` | Draft, posted and reversed legacy AR/AP migration batches |
| GET | `/accounting/opening-batches/:id` | `accounting.read` | Opening carry-forward detail, original legacy references and remaining items |
| POST | `/accounting/opening-batches` | `accounting.post` | Create an unposted reviewed migration draft; no fake sales/VAT/stock |
| PUT | `/accounting/opening-batches/:id` | `accounting.post` | Edit draft carry-forward only; submitted/posted items are immutable |
| POST | `/accounting/opening-batches/:id/transition` | `accounting.post` | Submit for approval, return unposted draft or cancel unposted batch |
| POST | `/accounting/opening-batches/:id/post` | `accounting.close` | Approve/post positive legacy AR/AP at fixed cutover against equity only |
| POST | `/accounting/opening-batches/:id/reverse` | `accounting.reverse` | Reverse an unconsumed opening batch append-only; never undo real settlements |
| POST | `/accounting/opening-items/:id/apply-credit` | authenticated / service-checked | Apply an already booked party/branch advance to an opening debt without moving cash |
```
