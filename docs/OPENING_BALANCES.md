# Opening customer/supplier balance carry-forward

## Scope and deliberate boundaries

This workflow imports **positive remaining legacy balances**: outstanding AR/AP debts AND party advance credits (customer prepayments/credit on account and supplier prepayments/debit balances left over from the old ledger). It creates no new sale, purchase invoice/GRN, VAT, inventory or tender. Source references, original dates and due dates are retained; new document numbers use a separate opening namespace. The offset is opening equity, never revenue/expense.

Each item carries an explicit `direction`: **debt** (the default — money the party still owes or is owed) or **credit** (already paid value the business still owes as goods/service or a refund). Amounts stay positive; the direction — not a negative number — carries the meaning. Cross-branch netting and correction of already settled opening batches are NOT silently inferred; they require separate accounting workflows. Ordinary advances already booked in this system CAN also be allocated to imported debt. A supplier credit-note offset currently targets operational supplier invoices, not opening items; imported supplier advances settle those through the normal advance-allocation path.

An accountant must reconcile the complete prior closing trial balance, source documents, branch allocation and equity offset. Software validation is not a source-document audit or statutory approval.

## Prepare and approve

1. Create or verify the actual customer/supplier master account codes and branch authority first. Set opening stock/bank/other verified balances separately; do not duplicate balances using manual control-account journals or fake retail invoices.
2. Open **Accounting → Opening balances → Import opening balances**. Choose ONE branch and its end-of-legacy-period cutover date, source-ledger reference and notes.
3. Enter customer receivables/advances and supplier payables/advances as positive amounts with exact original references/due dates and the correct direction. An optional original document date must not follow cutover or due date. The server resolves the real party; creator/company/currency/GL fields cannot be supplied.
4. Optional CSV headers: `kind,contact_code,reference,original_date,due_date,amount,direction,description`. Use `customer` or `supplier`, `debt` (default when omitted) or `credit`, ISO dates and plain decimal amounts; at most500 rows. CSV loads into a reviewable draft, not directly into posted books.
5. Save the unposted draft, review totals/references, then Submit. Submitted items cannot change until explicitly returned to draft. Unposted drafts can be cancelled, not erased as posted history.
6. An authorized accountant with accounting posting/closing authority approves with a reason. Maker/checker/self-approval policy and the **gross sum of all items**, not the smaller net equity offset, are enforced against approval authority.

The first approved batch fixes the branch cutover. All subsequent batches use that SAME date, strictly before all existing branch sales/invoices/receipts/payments/debt allocations. The API suggests the day before the first operating debt date (or yesterday for a new branch). Same-cutover-day operational debt posting is intentionally blocked: cutover means end of the old period, not permission to overlap new trading. Approval and operating journal inserts share a database lock, so concurrent first-trade/import cannot both cross the boundary.

Duplicate normalized legacy references for the same party/kind/**direction**/branch are rejected across active posted imports — a legacy receipt and a legacy invoice may legitimately share a reference string, while repeated debts or repeated credits of the same reference may not. Supplier references already in operational invoices are blocked for debt imports (credit imports are separate prepayment value). Customer legacy/system-generated numbering can overlap as separate namespaces; the reviewer must verify that the same economic balance was not entered twice. A cancelled/reversed unused import is never rewritten to hide it.

## What approval posts

- **Debt** items post item-level Dr receivables (customers) / Cr payables (suppliers) against opening equity.
- **Credit** items post Cr customer advances / Dr supplier advances against opening equity and are simultaneously registered as **real advance balances** (`advance_credits` with source `opening_balance`). They are allocatable exactly like advances booked through day-to-day receipts/payments — to future invoices, to imported opening debt of the same party/branch, or as ready credit at checkout.
- The equity offset is the net of both directions: Σ customer debts + Σ supplier credits minus Σ supplier debts + Σ customer credits. The deferred database guard now allows only receivables/payables/both advance control accounts plus equity inside an opening journal and verifies party, direction and amounts item-by-item; a missing/extra/cash/revenue/tax/stock line still rejects the whole batch.

## Settle actual debt and use imported credits

- Open the customer or supplier statement/payment dialog. Open items explicitly label **Opening** versus **Invoice**; both participate in pagination and server-capped allocation. Choose the actual confirmed tender/reference and allocate to the correct debt type. A receipt/payment may contain normal and opening items of the same party/branch.
- Excess actual receipt/payment money is still an ordinary booked advance. Existing receipt/payment advances can be applied to opening items, and the opening detail also offers **Apply booked credit** for an available matching party/branch credit — including credits imported through this workflow.
- Credit allocation moves the already recognized advance to AR/AP, NOT another bank/cash transaction. Source amount/date, party/branch, actual availability and target debt are rechecked under locks; raw over-allocation is rejected. Imported credit items are never settled as if they were debt (allocation guards reject them); their remaining value is shown per item as available advance.
- Imported receivables count in customer credit limits. Aging uses original due dates but recognizes imported balances only from their financial cutover. Sales/purchase counts and turnover remain unchanged. GL-backed contact statements include opening references and allocation sources; advance availability reports include opening-sourced credits.
- Print the opening schedule through the authorized PDF link. It shows direction per item and credit totals, and explicitly is not a new fiscal invoice.

## Correct an unused import

Only a posted, unreversed batch with **no settlement allocations and no consumed imported credits** can be reversed. Original rows/journals remain immutable; a matching opposite journal is appended at the **original effective cutover**. That period must be explicitly open, and approval/reversal authority and reasons are required. A current-day reversal followed by a backdated replacement would incorrectly double historical aging until today, so that combination is rejected.

Reversal also withdraws the unused imported credits exactly: an append-only record (`target_type='opening_reversal'`) consumes each credit's remaining availability so no value outlives its reversed equity/book entry. A batch whose credits were consumed — anywhere, including against another batch's debt — is reversal-proof history (database guard and API agree), and after actual money settlements the correction path is accountant-led rather than reversing paid history.

The fixed branch date is NOT reset by reversal. Review and post a replacement draft at the same cutover; historical balances then net correctly.

## Integrity and deployment

Migrations019–022 add FORCE-RLS/scoped-FK records, immutable posted content/reversals/allocations, date/reference/direction/cap guards, a serialized cutover, deferred exact party-source journal binding and opening-sourced advance credits with consumed-credit reversal guards. An opening batch cannot commit with a missing, cash/revenue/tax/stock journal, mismatched party dimensions or direction-inconsistent control accounts. Current company-wide reconciliation/restoration includes these balances in AR/AP and both advance control accounts.

Apply reviewed migrations explicitly and deploy matching code. Keep an encrypted matching-release DB+private-file snapshot; do not edit applied SQL checksums or drop/reseed existing data. Local tests include approval/currency-rounding, real receipts/payments/advances, mixed debt+credit batches with exact control-account parity, imported-credit allocation and consumed-credit reversal blocking, unused-credit withdrawal on reversal, duplicate/role/tenant/branch/period checks and concurrent cutover/last-debt races. Public host/provider/statutory acceptance remains open.
