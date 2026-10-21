# Deployment runbook — not an executed public deployment

The source contains real Docker, Ubuntu/systemd and Cloudflare Tunnel configurations. Container references are pinned to registry-verified manifest digests; this verifies availability, not image execution/security. Caddy2.11.7 `adapt/validate` and Compose2.40.0 `config --quiet` have run locally for base/Tunnel files. **Docker images/containers, public DNS/TLS, Cloudflare configuration and a real Ubuntu host have NOT been deployed/tested here.** Host credentials, domain, SMTP and Tunnel access were not supplied. Treat the following as a reviewed starting runbook with mandatory host acceptance gates.

## One-command go-live (recommended entry point)

From the repository root on a fresh Ubuntu LTS host with Docker Engine + Compose >= 2.24.4 installed:

```bash
bash deploy/go-live.sh pos.your-domain.example
```

The orchestrator is idempotent at every guarded boundary: it refuses to overwrite an existing `deploy/docker/.env.production`/backup key, reuses an already-provisioned business (the server's `SETUP_IDENTITY_EXISTS` refusal), and can be re-run after failures (it resumes at the step that failed). It performs the Docker quick-start's init-env generation, secret capture with hidden prompts (tunnel token, company, owner email/password — never shell history), the combined `docker/compose.yml` + `cloudflare/compose.tunnel.yml` configuration check, the pinned image build, database boot and health gate, reviewed schema migrations, first-business provisioning, application boot, readiness verification and the post-boot operator report (Cloudflare public-hostname binding to `http://proxy:8080`, no-cache/no-Rocket-Loader rules, backup-key custody, restore rehearsal).

A verified-TLS relay (`SMTP_URL`, plus a sane `MAIL_FROM`) is mandatory: the production API hard-fails at boot without safe password-reset delivery, so the orchestrator refuses to continue until a real `smtp://`/`smtps://` URL is supplied. Everything else this runbook says about secrets custody, acceptance gates and non-public ports still applies — the one command covers mechanics, not the operator's host acceptance responsibility.

The manual steps below remain the reviewed reference for direct-Caddy HTTPS, native systemd and for understanding what the orchestrator runs on the operator's behalf.

## Requirements and secrets

Use a patched Ubuntu LTS host, supported Node24.22.0 for native builds, PostgreSQL17 and version-pinned Caddy/images. Compose must support `!override` (>=2.24.4). Build/browser testing benefits from4GiB+ RAM; this is not a measured production sizing guarantee. No Redis/paid auth/database service is needed. A self-hosted verified-TLS SMTP relay is valid.

Allow only public80/443 for direct Caddy, or outbound Tunnel connectivity for Tunnel mode. Never publish5432/3000/4000. Keep production `.env`/keys0600 or0400, secrets directories0700, and backups/off-site keys independently protected. Do not put production `.env` in the Docker build context; `.dockerignore` excludes it.

## Docker, direct Caddy HTTPS

From the repository root:

```bash
bash deploy/docker/init-env.sh pos.your-real-domain.example
# Edit deploy/docker/.env.production privately:
# SMTP_URL must be a real, verified-TLS relay; check MAIL_FROM/domain.
# Keep generated MFA/backup/provider callback keys stable and separately backed up.
cd deploy/docker
# Bash convenience only; no credentials are echoed into command arguments:
dc() { docker compose --env-file .env.production -f compose.yml "$@"; }
dc config --quiet
dc --profile ops build api web migrate ops
dc up -d db
# Explicit schema migration, separate owning/privileged migrator:
dc --profile ops run --rm migrate
```

Fresh database initialization creates:

| Role            | Purpose                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `duka_migrator` | Dedicated DDL owner, intentionally BYPASSRLS so reviewed cross-tenant migrations/backfills are complete; never an API credential |
| `duka_app`      | Non-owning, non-superuser/non-BYPASS/non-CREATEDB runtime DML role; FORCE RLS applies                                            |
| `duka_backup`   | SELECT-only + intentional BYPASSRLS for complete snapshots                                                                       |
| `duka_restore`  | CREATEDB only for disposable recovery databases; not owner of the business database                                              |

Initialization runs only on a NEW PostgreSQL volume. It never resets existing passwords/data. After each migration the CLI explicitly grants configured runtime/backup access and revokes runtime writes to migration metadata. Never run `down -v`, reseed or drop a live database to fix a failed migration.

Provision the first real business explicitly (no demo seed):

```bash
read -rp 'Company name: ' SETUP_COMPANY
read -rp 'Owner email: ' SETUP_EMAIL
read -rsp 'Strong initial password: ' SETUP_PASSWORD; echo
export SETUP_COMPANY SETUP_EMAIL SETUP_PASSWORD
dc --profile ops run --rm -e SETUP_COMPANY -e SETUP_EMAIL -e SETUP_PASSWORD migrate artifacts/server/setup.mjs
unset SETUP_PASSWORD
# Then start the app and TLS proxy:
dc up -d api web proxy
dc ps
```

The setup password is not placed in shell history. The operator must configure actual tax/product/unit/opening-balance policies before trading. Production rejects demo/mock modes, unsafe DB roles, missing SMTP/MFA keys and migration mismatch. Default providers remain disabled.

Point DNS to the host. Initially use DNS-only if necessary to establish Caddy's valid origin certificate; if later proxying through Cloudflare DNS, use Full(strict), bypass application caching and disable HTML/JS rewriting/Rocket Loader. Never relax TLS verification to make it work.

API/web run non-root with read-only filesystems and restricted writable storage/cache. Ops containers deliberately have filesystem-read authority for private uploads/key and a separate DB role; they are not exposed HTTP services. Validate actual volume ownership and upload/download on the host. Logs rotate through Docker's JSON driver; configure disk monitoring and a real alert destination separately.

## Cloudflare Tunnel alternative

There is no connected Cloudflare account/Tunnel available to this project. Create the Tunnel and public hostname manually in your own account. Use the same private `.env.production`, set the real `TUNNEL_TOKEN`, and configure public hostname origin service `http://proxy:8080`.

```bash
# From deploy/docker; use both files consistently for ALL subsequent commands:
dct() { docker compose --env-file .env.production -f compose.yml -f ../cloudflare/compose.tunnel.yml "$@"; }
dct config --quiet
dct up -d api web proxy tunnel
```

The override removes public80/443 mappings and binds the origin8080 to host loopback only. Edge HTTPS + encrypted outbound Tunnel protects transit; origin HTTP is restricted to the private Docker bridge. The Caddy Tunnel file trusts `CF-Connecting-IP` only in this topology. Do NOT expose8080 directly or reuse that trust rule on a public untrusted listener.

Bypass CDN caching for the entire application host/API/auth/documents and avoid script rewriting that breaks nonce CSP. Daraja callback paths must reach the server without an interactive Access/WAF challenge; protect them with the application's token/query checks, not a browser challenge. If adding Cloudflare Access for staff, explicitly design the callback exception. No account setting or live callback has been verified here.

## Native Ubuntu/systemd option

1. Install pinned supported Node24, PostgreSQL17 client/server, Git, OpenSSL, Python3 (source packaging only) and Caddy using signed official repositories/packages. Validate package signatures/checksums; do not run unreviewed curl-to-shell installers.
2. Create separate non-login `duka` (API) and `duka-web` service users and versioned `/srv/duka/releases/<revision>` directory. Run `npm ci`, tests against a separate `_test` DB, and `DEMO_MODE=false API_INTERNAL_URL=http://127.0.0.1:4000 npm run build` as a build/deploy user.
3. Create the same separate DB roles above using an administrator. Keep migration and runtime connection files separate. Run reviewed migrations with the owner credential and `RUNTIME_DB_ROLE`/`BACKUP_DB_ROLE` explicitly configured.
4. Put runtime config in `/etc/duka/api.env`, protected by root. Web config needs only port/hostname/frame policy, not database/MFA/provider secrets. Install templates in `deploy/ubuntu`; adjust the verified `node` executable path and current-release symlink.
5. Create `/var/lib/duka/uploads` owned by `duka`0700, and the standalone `.next/cache` directory owned by `duka-web`0700. Set `PUBLIC_HOST` for Caddy (systemd environment override), install the native Caddyfile and enable the API/web services. Caddy admin API is disabled; restart rather than hot-reloading its config. Proxy error URI/headers are filtered, not just access logs disabled. Root-only backup jobs read private uploads using the separate SELECT-only DB credential.
6. Enable tested backup/restore timers and off-site monitoring; do not call a timer “working” until successful restore reports and alerts exist on that host.

`systemd-analyze verify` passed for the supplied units/timers; that is static validation, not host execution. Timer schedules use the host timezone; configure it deliberately. Install unit files, run `systemctl daemon-reload`, then enable services/timers only after the real host acceptance run.

Systemd templates are not proof of host execution. Do a real non-root/read-only filesystem, startup, restart, SMTP, callback, printing, upload, period-lock and backup/restore acceptance run.

## Upgrade and rollback

**One command, never from scratch** — run it from the new release against the installed target:

```bash
sudo bash /path/to/new-release/deploy/update.sh --src /path/to/new-release /opt/duka
```

It validates the healthy existing stack, rsyncs the new source in WITHOUT touching the 0600 env/backup key/volumes, runs a fresh encrypted backup (decline only with `--skip-backup` when a very recent verified one exists), tags the running images ':previous', builds the new `RELEASE=`-tagged images, applies forward-only migrations with the migrator role, swaps only api+web (db/proxy/tunnel/volumes untouched), health-gates and auto-rolls back to ':previous' if the new API fails to become healthy, and finally runs `deploy/self-check.sh` against the live HTTPS host. Every step is restartable; nothing destructs by design. A manual instant rollback afterward is: `docker tag duka-api:previous duka-api:local && docker tag duka-web:previous duka-web:local`, reset `RELEASE=local` in the env file, then the usual `dc up -d api web` — never roll back CODE across an incompatible applied migration.

- Keep a verified encrypted DB+files backup and matching source/image revision before upgrading.
- Review migration SQL and dependencies; do not edit applied migration checksums. Stop/drain financial traffic for schema changes that require it; apply explicitly, then deploy the matching API/web images.
- Readiness must pass. Exercise a controlled transaction, permission check and all-location reconciliation before reopening.
- Rolling back code without a compatible schema is not a safe rollback. Use a new isolated recovery database/storage volume and validated cutover when necessary; never overwrite or drop the only good copy.

Host acceptance: TLS/cookies/CSP, no public backend ports, correct forwarded client IP/rates, stable master keys, SMTP real mailbox delivery, printer formats, branch/warehouse roles, storage permissions, provider/fiscal onboarding, resource/load/fault tests, off-site retention, restore rehearsal and operator/accountant/security approval.
