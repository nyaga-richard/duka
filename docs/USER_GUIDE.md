# Staff guide

## Sign in and choose the right workspace

Use your own account, branch and register. If the embedded development preview blocks SameSite session cookies, open the preview in a top-level tab; production should not be made broadly cross-site just to embed it. Roles control what you can see/do; a disabled or missing option is not permission to edit requests in developer tools. Cost/profit fields may correctly show Restricted. Use the account/security screen for password/MFA; recovery links expire and are single-use. Never share passwords, browser profiles or active sessions.

## Checkout

1. Open your assigned till and count existing float. Find/scan items, confirm base/selling units, quantities, batches/serials and customer where needed.
2. Review the server-priced basket. Overrides/discounts/below-cost exceptions need the appropriate authority and reason. A saved cart/order is not a posted sale.
3. Choose confirmed tenders or authorized credit. Split cash/bank/card/M-Pesa correctly; enter actual references and actual cash received/change.
4. M-Pesa prompt = Pending. Wait for verified success. Do not mark a promise, screenshot or offline prompt as money received. Mock provider buttons exist only in an isolated demo/test setup.
5. Confirm once. “Sale complete” means the server committed sale/stock/GL. Printing/receipt retrieval can fail separately; a known posted sale must not be posted again because a PDF is unavailable.

### If the response is missing

The locked cart and original key are recovery protection, not a lost sale. Retry unchanged. Later401/403/429 does not prove the original failed; reauthenticate/reconcile rather than creating a replacement. Do not erase browser storage or switch to offline capture for an uncertain online checkout.

**Recover or cancel unposted** asks the server to either return the already posted receipt or permanently cancel only that unposted intention. A DB tombstone blocks delayed old packets. It never deletes a posted sale and never refunds a bank/M-Pesa transfer. Reconcile any money already received with a manager before creating a distinct corrected intention. If permissions changed, the server may require resource reconciliation; historical privileged responses are not blindly replayed.

## Returns

Open the original sale and choose Return/credit note. Enter only actual unreturned quantities and a meaningful reason. Restock only goods physically received. Choose actual refund method/open cash shift or authorized account credit. An external pending refund stays a liability until independently reconciled; bookkeeping does not send money. Never refund twice because a response or printout is missing.

Supplier returns are against the matched receipt/invoice. A paid-return credit can be applied to another invoice or actually refunded from Purchasing → invoice → Settle supplier credit. Corrections use the dedicated immutable reversal flow; do not edit old amounts.

## Inventory and purchasing

- PO → approval → accepted GRN → matched invoice are separate steps. Received quantity is not automatically invoiced or paid.
- Count the selected warehouse, not another store. Changing warehouse/document type invalidates old count snapshots; late responses cannot restore the old scope. Load current system quantities, enter actual physical counts, then post. Intervening movement requires refreshing/recounting, not forcing a version.
- Keep batch/expiry/serial identity accurate. Do not use an aggregate count to bypass tracked-item rules.
- Corrections are new controlled documents; posted movements/financial records cannot be overwritten/deleted.

## Legacy debt (authorized accountants)

Accounting → Opening balances supports positive outstanding customer/supplier debts, not new sales or tax invoices. Prepare/CSV-load a draft, verify original references and due dates, submit and obtain authorized approval at a fixed cutover. Imported debts appear in ordinary Customer/Supplier payment allocation with an explicit Opening label and count toward credit limits. Only already booked matching credit can be applied without a new tender. No allocated import can be reversed as if real money never moved. See OPENING_BALANCES for scope and maker/checker rules.

## Paid expense refunds

Open the posted expense voucher → **Record expense refund**. Enter the actual confirmed tender/reference/amount and reason. The server uses original expense/VAT/account snapshots, caps the unrefunded balance and applies approval policy. **Repay** is only for an actual outgoing repayment of that refund; it does not cancel a bank/M-Pesa transfer. Print the authorized refund/repayment voucher from its history. Do not use a fictitious refund for a payment that never happened; ask an accountant for the appropriate correction.

## Offline cash

An authorized manager registers the correct operator/register/device. While connected, cache the authorized catalog and keep an open shift loaded. This is a **warm-session fallback**, not a complete cold-start offline application.

Offline capture is restricted to standard-price walk-in cash, within the device limit: no credit, orders, manual pricing, bank/card or confirmed M-Pesa. A saved local capture is **NOT a sale or fiscal invoice**. Record actual cash and preserve the device/private queue. Two tabs use atomic queue updates, but avoid operating multiple competing carts unnecessarily.

When online, open Offline & sync and synchronize each capture. Server rechecks device/operator/location, original shift, age≤24h, catalog/tax, stock, totals and permissions. Posted status + sale link is authoritative. A conflict means no new sale/stock/GL was posted by that attempt; review the original cash/history before any re-entry. Legacy captures without a shift ID and captures from a replaced/closed drawer require manager reconciliation, not rebinding/editing JSON.

Synchronize before submitting the shift/signing out. The UI warns before clearing unconfirmed private data. Export an unresolved queue only to approved protected storage; server backups do not contain your unposted browser data. Never take a second payment simply because synchronization is delayed.

## Reports, receipts and help

Use authorized date/location filters. A restricted or empty report is not proof that stock/debt is zero elsewhere. Ordinary printed receipts/credit notes are not certified KRA documents unless the separate verified fiscal status/identifier says so. Ask an authorized operator about tax/provider/compliance requirements; do not type fake fiscal IDs or references.

For support, record the request ID, document reference, time, register and visible error. Do not share cookies, CSRF/reset links, callback URLs, MFA secrets, private receipts or live browser traces in public tickets.
