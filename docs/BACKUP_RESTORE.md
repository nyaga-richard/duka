# Encrypted backup and restoration

## What is implemented and actually tested

`backup.mjs` creates a PostgreSQL custom dump and copies **referenced immutable private attachments** from the same exported DB snapshot. It records all public-table row counts/order-independent fingerprints, dump SHA256 and per-file SHA256/size in an encrypted manifest. An explicit read-only BYPASSRLS role prevents partial-tenant dumps.

The payload is authenticated **AES256-GCM**, using a fresh salt/nonce and scrypt(N32768,r8,p1) to derive the key. The fixed version header is authenticated. Final ciphertext is fsynced/atomically renamed; incomplete files use `.partial`. The passphrase file must be0400/0600 and contain at least32 random characters. Use an independent random32-byte value; never reuse the DB or MFA key.

`restore-test.mjs` authenticates the ENTIRE archive before extraction/DB creation, rejects unsafe paths/links, checks dump/file hashes, restores to a generated `duka_restore_<timestamp>_<random>` DB, compares every table's rows/fingerprints, runs company-wide stock/journal/tracking/AR/AP/advance/GRNI/refund reconciliation, then drops only that generated DB. It refuses existing business DB targets and requires a maintenance URL ending `/postgres` or `/template1`.

This sequence has really run locally. Exact table/file/tenant counts and cleanup result are in `artifacts/verification/restore.json`; corrupted-ciphertext rejection is recorded separately. See VERIFICATION for the latest matching release. Counts/fingerprints are diagnostic equality checks, not a substitute for cryptographic authentication or an external accounting audit.

## Key and staging policy

Backups deliberately do NOT contain runtime `.env`, DB role passwords, the MFA encryption key, provider/SMTP secrets, unrelated orphan files, OS files or Git history. Securely preserve those recovery materials separately. Restore the SAME stable MFA key to decrypt existing enrollments. Keep matching source/images/migration SQL with each backup generation; use that release to verify an old backup before explicitly migrating forward.

Private temporary plaintext dump/tar staging exists during backup and isolated restore. Normal cleanup removes it. Crashes/power loss can leave protected staging directories; encrypted disks and an operator-reviewed stale-staging policy are required where that threat matters. Do not automatically delete recent files/unknown COMMIT outcomes. Orphan-upload maintenance is not implemented.

**Off-site copies must include only FINAL `.enc` files and their `.enc.sha256` companions. Never copy an entire backups volume/directory: it can contain active plaintext staging or disposable restore files.** Keys belong in a different protected location, not beside ciphertext.

## Native commands

Install PG17 `pg_dump`/`pg_restore` and GNU tar. Use the same server major for recovery tooling. Configure operator-only environment privately:

```text
BACKUP_DATABASE_URL=postgresql://read_only_backup_role:...@db/duka
BACKUP_DIR=/var/backups/duka
UPLOAD_DIR=/var/lib/duka/uploads
BACKUP_PASSPHRASE_FILE=/etc/duka/backup.key
RESTORE_ADMIN_DATABASE_URL=postgresql://disposable_restore_role:...@db/postgres
```

```bash
node artifacts/server/backup.mjs
node artifacts/server/restore-test.mjs /private/path/duka-....enc
# Optional sanitized success report only after cleanup succeeds:
RESTORE_REPORT_FILE=/private/restore-report.json node artifacts/server/restore-test.mjs /private/path/duka-....enc
```

The backup role needs CONNECT/USAGE/SELECT on all source tables plus explicit BYPASSRLS, not write/DDL/superuser authority. The restore role needs CREATEDB and owns only disposable recovery databases. Fingerprinting temporarily removes FORCE RLS **inside a rolled-back transaction in that clone only**, then verifies domain data with normal tenant context. No source RLS setting or business data is changed.

## Docker commands

From `deploy/docker`, using the same base/Tunnel Compose files as deployment:

```bash
dc --profile ops run --rm ops artifacts/server/backup.mjs
# Copy the returned finalized filename, not a placeholder:
dc --profile ops run --rm -e RESTORE_REPORT_FILE=/backups/restore-latest.json ops artifacts/server/restore-test.mjs /backups/ACTUAL_FINAL_FILENAME.enc
```

Ops uses disk-backed `/backups` for temporary restore space rather than requiring a large dump to fit in RAM. Reserve sufficient free space for plaintext/custom dump/extraction plus the disposable PostgreSQL database (often multiple times source size; measure on the real dataset). A restore report is written only after hash/reconciliation checks AND generated DB cleanup succeed.

## Real recovery / cutover

1. Declare an incident, stop financial writers/workers, preserve the damaged DB and private files, and identify a verified backup + matching application release. Do not overwrite the original.
2. On isolated hardware, run the disposable restore check first. Protect ciphertext/recovery keys, inspect hashes and reconciliation, and verify that original business DBs are untouched.
3. Authenticate/extract to a NEW private directory:

   ```bash
   node artifacts/server/unpack-backup.mjs /private/backup.enc /private/new-recovery-directory
   ```

   It refuses an existing destination, authenticates before extraction and verifies all files. The result is sensitive plaintext; keep it private.

4. Create a NEW production-recovery DB owned by the migrator, recreate separate runtime/backup roles and restore `database.dump` using `pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname=NEW_DB`. Supply credentials securely (service/PGPASSWORD file/environment), not in shell history. Never point this at the old DB.
5. Restore `uploads/` into a NEW private storage location with the service user's0700/0600 ownership. Preserve relative opaque keys; never replace filenames with receipt names.
6. Grant runtime/backup permissions with the matching migrator; run matching-release readiness/integrity and manually compare representative receipts/stock/AR/AP/advances/tax/bank/provider statements. Provider/external transfers after the snapshot must be reconciled, not replayed blindly.
7. Revoke restored sessions/tokens as an explicit incident action, supply the SAME MFA key and required provider secrets, validate actual non-root services, then approve a documented DB/storage configuration cutover. Only then start workers and reopen staff access.
8. Retain the old DB/files and evidence until the operator's recovery/retention policy authorizes removal. Remove private extraction/staging securely under that policy after validation.

## Scheduling, retention and monitoring

A reasonable starting policy is daily encrypted snapshots plus periodic separate-host restore rehearsals, longer monthly retention and multiple off-site copies. This is NOT an executed schedule, measured RPO/RTO or business-approved retention policy. Define actual objectives, monitor job exit codes/backup age/disk space/SMTP/provider queues, and test failure alerts. Timers/templates in `deploy/ubuntu` are starting points only.

Deleting old ciphertext should be a separate reviewed process that retains multiple verified recovery points and excludes current `.partial`, staging and restore work. No automatic pruning is shipped. Storage encryption, off-site destination/credentials, separate-key custody and real disaster recovery sign-off remain operator responsibilities.
