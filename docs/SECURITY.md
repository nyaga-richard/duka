# Security posture and operating requirements

## Implemented, locally exercised

- Argon2id password hashes; opaque DB-backed session token hashes, expiry/revocation; HttpOnly/SameSite cookies and production Secure enforcement. MFA uses authenticated encryption with an independently configured stable32-byte base64 key; development fallback is not a production key policy.
- Exact HTTPS origins in production, CSRF and cross-site mutation rejection. Authentication endpoints have small bodies; unauthorized/CSRF-invalid financial uploads are rejected before their8MiB parser runs.
- TOTP setup expiry/replay protection; serialized reset links; persistent rate counters. Recovery tokens and queued mail are one transaction. SMTP failures cannot expose account existence through delivery errors; worker leases/backoff/expiry and immediate delivered-body clearing limit raw-token retention. Production SMTP verifies TLS, and disabling global certificate verification is rejected.
- FORCE RLS, scoped FKs, server memberships/permissions and cost redaction. Cashier HTTP regressions cover catalog, sale headers/lines/components/lists, checkout and dashboard margin. Further endpoint/CSV and positive-role review is still required.
- Immutable posted journals/stock/documents, database balance/append guards, controlled reversals, lock/recheck transaction boundaries and actor-bound idempotency. Exact decimals, not JavaScript binary money.
- Production nonce script CSP without unsafe-inline/eval; Zod JIT disabled, no remote scripts/fonts. Inline styles remain allowed by policy; this is not a claim of a maximally restrictive style CSP.
- Private uploads:0700 directories,0600 exclusive files,5MiB PNG/JPEG/PDF signature/size checks, authorized metadata/download, `Content-Disposition: attachment`. Atomic expense metadata + receipt, immediate partial-write rollback registration, file/directory fsync before metadata commit, cleanup fault regression and tenant privacy checks. These primitives do not replace a real host power-failure drill.
- Readiness rejects direct/inherited runtime table or database ownership, public-schema CREATE/server-administration memberships, and superuser/BYPASSRLS/CREATEDB/CREATEROLE/replication authority, missing/extra/changed migrations and missing critical FORCE RLS. Production configuration rejects demo/mock payments, sandbox Daraja endpoint and unconfigured SMTP/key/origins.
- Application HTTP logs redact callback tokens and do not log bodies/cookies/passwords. Proxy access logging is intentionally not enabled because callback paths and reset query strings contain bearer material; structured proxy-error URI/headers are also filtered and a real local502 probe verified redaction. Malformed credential-bearing startup URL errors are sanitized.

## Operator responsibilities / not claimed

No penetration test, regulatory approval, independent accounting audit, complete malicious-file parser, malware scanner, OS/container vulnerability scan, cross-browser audit or production load/failover exercise has been completed. A zero-vulnerability **npm production dependency** result does not cover the OS, images, logic or configuration.

Use a supported patched Node24/PostgreSQL17 host, TLS, NTP, encrypted disks where required, least-privilege users, firewalling and monitored disk capacity. DB5432, API4000 and frontend3000 must not be public bypasses around the proxy/Tunnel. Do not expose private storage via a static web alias. Separate database migration/runtime/backup/restore credentials and keep administrator/migration credentials out of API/web containers.

Protect `.env`, deployment secrets, MFA encryption key, callback secret, SMTP/provider keys and backup passphrase. Store recovery keys separately from ciphertext and independently off-site. Losing the MFA key can make restored enrollment secrets unusable; rotating it requires a planned decrypt/re-encrypt process, not editing an environment value. `init-env.sh` refuses to overwrite existing secrets.

A full backup role intentionally bypasses RLS **for SELECT only**. It is not an API role. Restore verification creates/drops only generated disposable DB names and never accepts an existing business DB target. Temporary plaintext dump/archive staging is private and removed normally; crashes can leave private staging. Use protected/encrypted disks and an operator-reviewed stale-staging process; never upload entire backup directories including staging to off-site storage.

Offline product/cash drafts live in the operator's browser profile and are not encrypted at rest by the app. Use dedicated locked devices/browser profiles, disk encryption and screen locks; do not treat a shared OS login as isolation. Explicit sign-out clears local private data after warnings for unconfirmed captures/online commands. Session expiry preserves drafts for reauthentication/reconciliation. Never clear browser storage to “fix” a financially uncertain request.

Rate limits are persistent and conservative; validate shared-NAT, proxy/client-IP and staff-shift behavior on the deployment. Configured trust-proxy hops must match topology. Only trust `CF-Connecting-IP` on the private Tunnel-only origin; never expose that HTTP origin directly. Disable CDN caching/HTML/JS rewriting that can defeat nonce CSP or leak authenticated data.

## Incident handling

1. Preserve request IDs, relevant audit/ledger IDs, backup manifests and sanitized application logs; never send raw credentials, live browser traces, callback URLs or private receipts to public issue trackers.
2. Disable affected users/revoke sessions; rotate compromised API/provider/SMTP credentials with the operator. Do not rotate MFA/backup keys blindly or rewrite/delete posted history.
3. Reconcile inventory, AR/AP/advances/GRNI/refunds and provider/bank statements. Use controlled domain corrections; unresolved provider outcomes remain pending.
4. Restore into an isolated new DB/storage location, validate hashes/financial controls, and explicitly approve cutover. See BACKUP_RESTORE.
5. Complete root-cause review and independent security/accounting sign-off before resuming real operation.

## Workspace continuation

`WORKSPACE_PREVIEW=true` is refused with a production API, non-demo configuration, live Daraja or fiscal adapter mode. Only the isolated viewer uses distinct `duka_workspace_session` HttpOnly/Secure/SameSite=None/Partitioned cookies; mixed legacy cookies cannot change the actor and matching logout removes the partition. Normal production remains `duka_session` Secure/HttpOnly/SameSite=Lax. No bearer token is placed in browser storage and no Origin/CSRF/RBAC check is removed. Real cross-site iframe/reload/logout was tested with a stateless HTTPS bridge, not a hidden request-context cookie jar.

Opening carry-forward source journals are restricted to exact AR/AP party dimensions and equity, never cash/stock/revenue/VAT. Positive item/source allocation caps, branch/party/date/reference guards, fixed cutover serialization, immutable submitted/posted content, approval limits and unused-only original-date reversal are enforced. Advance listing is filtered by actual receive/pay authority so a receivables clerk cannot inspect supplier prepayments by calling the shared endpoint.
