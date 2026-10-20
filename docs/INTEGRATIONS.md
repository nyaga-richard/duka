# Payments, fiscal boundary and mail

## M-Pesa

Modes: `disabled` (safe default), `mock` (explicit isolated development/demo only), `daraja` (merchant credentials required). Production rejects mocks and a sandbox base URL; live posting requires `https://api.safaricom.co.ke`. Development sandbox endpoints are not real-money confirmation for a live company.

Required live configuration: consumer key/secret, shortcode, passkey, HTTPS callback base and an independent strong callback secret. Initiation only creates a pending intent/dispatch. A callback is token-bound and matched to the stored checkout/provider/amount/phone; a recorded provider query must confirm success. Receipt uniqueness and consumed-intent checks prevent reuse. Delayed, duplicate, mismatched and out-of-order callback behavior is covered locally with the independent mock transaction store, **not with a live merchant account**.

STK Push uses whole KES. Never silently round a fractional cart into a different charge; use legitimate split settlement where appropriate. Initiated/offline/pending M-Pesa is not paid. An ordinary receipt must not imply a successful provider transfer.

Manual incoming M-Pesa statement reconciliation additionally requires integration-management authority and audit evidence. External outgoing/B2C refund automation is not implemented/certified. Pending customer refunds stay liabilities until an authorized operator records independently reconciled settlement; no money is sent by that bookkeeping action. Supplier credit refund recording likewise records an actual incoming transfer, never initiates one; outgoing M-Pesa repayment is not fabricated.

Before enabling: confirm merchant ownership, live credentials/transaction type, public callback reachability, authentic client-IP routing, provider reconciliation and duplicate/timeout recovery on the actual account. Daraja callbacks are not treated as cryptographically signed provider evidence; protect callback material, validate the independent query and perform statement reconciliation.

## KRA eTIMS

The code provides a disabled-by-default persistent fiscal adapter boundary (`ETIMS_MODE=adapter`, approved HTTPS gateway URL/token), not a certified OSCU/VSCU product. Sales/credit notes retain immutable financial history and separate fiscal submission status/IDs/errors/retries. No fake control-unit number, fiscal signature or KRA ID is generated. Ordinary documents visibly remain non-fiscal. A required fiscal policy rejects an unset/disabled adapter for sales and credit notes.

Enabling a URL is not certification. The operator must supply a certified/onboarded integration, taxpayer/device/branch configuration, item/unit/tax mappings and credentials. OSCU/VSCU behavior, original-invoice credit-note references, numbering, outage handling and legal requirements must be validated with the approved solution. Local callbacks/tests do not establish tax compliance.

Official starting references (consult current KRA instructions):

- https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/etims-system-to-system-integration
- https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/types-of-etims-solutions
- https://etims.kra.go.ke/main/signup/indexLearnMore

## SMTP and recovery

`MAIL_MODE=outbox` is private development-only inspection, not email delivery. Production requires `MAIL_MODE=smtp`, `SMTP_URL` and a valid sender; `smtps://host:465` uses verified TLS, `smtp://host:587` requires verified STARTTLS. URL-encode credentials; arbitrary insecure transport query overrides are not supported.

A reset request atomically stores a hashed30-minute token, its delivery job and a security event, then returns a generic response with minimum/jittered timing. Worker3s cadence claims SMTP-only jobs with leases, retries/backoff and expiry. Legacy development outbox records are never mailed when production starts. Delivered/expired bodies are cleared; metadata remains for operational audit. Delivery is at-least-once, not exactly-once; a stable Message-ID assists duplicate handling.

The local production smoke actually used a certificate-verified TLS SMTP sink plus HTTPS browser reset/session-revocation flow. **Real mailbox delivery, DNS SPF/DKIM/DMARC, bounce monitoring and the deployment relay have not been tested.** Test those with the operator before opening registration/recovery to staff.
