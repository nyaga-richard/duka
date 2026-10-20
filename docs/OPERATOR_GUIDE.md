# Operator/accountant guide

## Before the first real transaction

1. Complete DEPLOYMENT, SECURITY and the open acceptance gates. Use a new, non-demo business with strong unique owner credentials, stable MFA key, real verified-TLS mail and a tested recovery path. Never promote public demo credentials/data into production.
2. Verify company name, tax PIN/contact details, currency/timezone, receipt format/footer and accounting periods. Review every tax code/rate/inclusive/exclusive/exempt rule with your accountant. The16% seed is illustrative, not legal certification.
3. Configure branches, warehouses/registers, payment methods/GL accounts, approval limits and staff memberships. Give cashiers minimal permissions. Device authorization currently uses `sales.price_override`; the operator picker additionally needs user-management access. Do not assume a permission name covers only one UI button; inspect API.md/runtime permissions.
4. Keep separation of duties. Self-approval is disabled unless explicitly enabled; when enabled it still requires a meaningful reason and respects limits.
5. Configure units/base quantities and conversions before using stock. Test bundle components, selling-unit returns, batch/expiry and serial identity with representative goods. Tracked goods use tracking-specific documents, not aggregate counts.
6. Enter verified opening inventory using the explicit opening stock workflow. Book real existing cash/bank/equity balances through an authorized opening/manual GL entry. **Opening drawer float is a physical count, not income or a new capital injection.** Do not double-book it each shift.
7. For positive outstanding legacy AR/AP, use Accounting → Opening balances, review source references/remaining amounts and approve an explicit end-of-legacy-period branch cutover. No sales, VAT, stock or cash is created; real receipts/payments and booked advances subsequently settle those items. Unused corrections append at the same original effective date in an open period. Credits/advance imports and post-settlement correction are not silently supported. Do not fabricate retail sales/GRNs or unsupported control-account journals. Read OPENING_BALANCES and reconcile the old closing trial balance before approval.
8. Run company-wide integrity with complete branch/warehouse coverage, perform a real encrypted backup/restore rehearsal and record accountant/operator acceptance.

## Daily cash control

- Cashier opens the correct register and counts existing float. Cash = opening float + cash tenders/receipts/refunds-in − cash refunds/payments ± cash movements; bank/card/M-Pesa are separate.
- Review pending provider outcomes and local captures throughout the day. A prompt, locally captured sale or unconsumed provider intent is not a posted sale.
- Before submission: synchronize/reconcile all offline cash and resolve uncertain online commands. The browser blocks submission while its local queue has unposted captures; this cannot attest to another device's storage. Server sync also binds captures to their original shift and refuses a replacement drawer.
- Count actual cash/denominations and actual noncash statement totals independently. Submit; an authorized reviewer checks differences. Noncash discrepancies must be resolved before approval. Cash variance journals require the review workflow, not deletion of old tender history.
- Cash-out, expense/supplier payouts and refunds cannot exceed expected physical cash while holding the drawer lock. A book entry is not a substitute for the actual money/statement.

## Purchasing and AP

1. Create PO in base purchase quantities/costs; submit and obtain authorized approval.
2. Receive only accepted quantities/batches/serials; record rejected quantities. GRN posts stock and GRNI, not the final supplier liability/tax invoice.
3. Match the supplier's actual invoice to the GRN, net/tax rules and reference; review price variance. This recognizes AP/input tax and clears GRNI.
4. Record an actual payment against explicit outstanding items; excess funds become a supplier advance. Allocations are scoped to contact/branch and server-capped.
5. Return goods against the original received/invoiced lines, with original serial identity. A paid return can create an AP credit balance; it is not silently turned into an unrelated cash refund.
6. On invoice detail choose **Settle supplier credit**: offset another open invoice of the same supplier/branch, or record an actual confirmed refund received. Partial amounts are supported; dates cannot precede related activity. Source documents remain immutable.
7. Correct a credit allocation with **Reverse**. A refund reversal requires an actual outgoing repayment, not pretending a bank transfer was automatically cancelled. Duplicate reversals/overdraw and cross-contact/branch allocations are blocked.

## AR, returns and expenses

- Review credit limits/due dates before credit checkout. Customer receipts/advances use explicit allocations and FIFO consumption; opening balances are not editable contact attributes.
- Sales returns use original line quantities, prices/tax and stock cost, with unreturned caps. Restock only actual returned goods. Paid cash/bank refunds, account credit and pending external refunds have different ledger effects; do not confuse them.
- An expense request is not a posted payment. Submit purpose/category/tax and optional private receipt together, obtain approval, then pay the approved amount using a confirmed method. Failed receipt persistence rolls back the request; do not create a replacement after an uncertain response.
- For a paid voucher, Record expense refund posts only money actually received, with original posted account/net/VAT caps. Repay reverses a refund only for an actual outgoing repayment; original records remain immutable. Category edits cannot redirect historical credits. Budget/approval/branch/period/cash guards apply. No external transfer is sent or cancelled.
- No-transfer erroneous-entry expense void/reclassification and normal paid asset acquisitions/disposals are still incomplete. Opening assets/straight-line depreciation exist. Use the known-gap/review gates rather than an operational GL-only reversal that leaves a register/subledger inconsistent.

## Closing and reports

`npm run db:reconcile` / bundled `reconcile.mjs`, or GET `/accounting/integrity`, requires all branches and every warehouse in those branches. It checks movement/cache/GL inventory, tracking, journals, AR/AP, advances, GRNI and pending refunds. Period closing blocks an unreconciled company and locks posting; reopening is explicit/audited. Locking a period is not automatic year-end retained-earnings/statutory closing.

Reports derive from posted GL/subledgers. Defaults use the company's calendar; use explicit correct dates when the browser/operator is in a different timezone. Cash-flow output is ledger movement by source, not independently classified statutory cash flow. CSV/PDF pages have explicit pagination/caps; do not call a single page a complete ledger. Resolve all material differences with source documents/bank/provider statements.

Back up daily under your approved policy, verify off-site ciphertext copies/key custody, monitor failures and regularly restore on separate hardware. Maintain an incident log, source/image revision and evidence. Do not remove old databases/history because a report is inconvenient.
