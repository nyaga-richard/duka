#!/usr/bin/env bash
# Duka Business OS — one-command go-live (Ubuntu + Docker + Cloudflare Tunnel).
#
#   bash deploy/go-live.sh pos.your-domain.example
#
# What it does, in order (safe to re-run; it never recreates existing secrets,
# never resets an existing database, and never prints secret VALUES):
#   1. Verifies Docker Engine + Compose >= 2.24.4 (required for !override).
#   2. Generates private configuration/keys once via docker/init-env.sh
#      (skips silently when already generated).
#   3. Asks ONCE (or accepts env) for: Cloudflare Tunnel token, first business
#      name, owner email and a strong initial password (prompts are hidden and
#      never echoed into files or logs).
#   4. Builds the pinned api/web/ops images, starts PostgreSQL, applies the
#      reviewed schema migrations with the dedicated migrator role, provisions
#      the first business, then starts web + api + loopback Caddy + the Tunnel.
#   5. Waits for readiness and prints the post-boot verification checklist.
#
# Email delivery: password resets, invitations and alerts REQUIRE a real
# SMTP relay (smtps://user:pass@host:465 or smtp://...:587 STARTTLS). The API
# refuses to boot in production without one — this script enforces it up
# front; there is deliberately no outbox bypass in the production lane.
#
# Optional env overrides: TUNNEL_TOKEN, SETUP_COMPANY, SETUP_EMAIL,
# SETUP_PASSWORD, SMTP_URL, MAIL_FROM, PUBLIC_HOST. Interactive piped runs can
# export them all for a fully unattended roll-out.
set -euo pipefail
cd "$(dirname "$0")"
DOCKER_DIR="docker"
ENV_FILE="$DOCKER_DIR/.env.production"
PUBLIC_HOST="${PUBLIC_HOST:-${1:-}}"

die() { echo "go-live: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

[[ "$PUBLIC_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,63}$ ]] ||
  die "usage: bash deploy/go-live.sh pos.your-domain.example (a real public hostname you control in Cloudflare)"

step "Checking Docker Engine and Compose"
docker version >/dev/null 2>&1 || docker ps >/dev/null 2>&1 ||
  die "Docker is not reachable. Install Docker Engine on Ubuntu and grant this user membership of the docker group (see docs/DEPLOYMENT.md), then re-run."
compose_extra() { docker compose version | sed -E 's/^Docker Compose version v?([0-9.]+).*/\1/'; }
compose_version=$(compose_extra)
compose_major=${compose_version%%.*}
compose_rest=${compose_version#*.}
compose_minor=${compose_rest%%.*}
compose_patch=${compose_rest#*.}
ok=1
if ((compose_major > 2)); then ok=0
elif ((compose_major == 2)); then
  if ((compose_minor > 24)); then ok=0
  elif ((compose_minor == 24 && compose_patch >= 4)); then ok=0; fi
fi
((ok == 0)) || die "Docker Compose >= 2.24.4 is required for the !override Cloudflare Tunnel stack (found ${compose_version}). Upgrade Compose via the official Docker apt repository and re-run."

step "Preparing private configuration (generated once; never overwritten)"
if [[ -e "$ENV_FILE" ]]; then
  echo "Using existing private configuration $ENV_FILE (mode 0600)."
else
  bash docker/init-env.sh "$PUBLIC_HOST"
  echo "Generated random database passwords, MFA key and the SEPARATE backup key."
fi
# Reassert the public host; an override arg wins only on first generation.
step "Capturing go-live inputs (hidden from terminal history)"
read_var() { # read_var NAME "prompt" default
  local name=$1 prompt=$2 default=${3:-} value
  if [[ -n "${!name:-}" ]]; then return 0; fi
  read -rsp "$prompt${default:+ [$default]}: " value
  echo
  printf -v "$name" '%s' "${value:-$default}"
  export "$name"
}
read_var TUNNEL_TOKEN "Cloudflare Tunnel token (from the zero-trust dashboard; stored only in 0600 $ENV_FILE)"
[[ ${#TUNNEL_TOKEN} -ge 20 ]] || die "The tunnel token looks too short; create a Cloudflare Tunnel named for $PUBLIC_HOST and copy its token."
[[ "$TUNNEL_TOKEN" =~ ^eyJ[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]+$ ]] ||
  die "The tunnel token does not look like a Cloudflare tunnel JWT (expected 'eyJ...' with three segments). Copy ONLY the token value from the dashboard — no 'cloudflared tunnel run --token' prefix, no quotes or spaces. If it is a raw token log: 'docker compose logs tunnel'."
read_var SETUP_COMPANY "First business/company name"
read_var SETUP_EMAIL "Owner login email"
read_var SETUP_PASSWORD "Strong owner password (12+ chars, letters and digits)"
[[ ${#SETUP_PASSWORD} -ge 12 && "$SETUP_PASSWORD" =~ [a-zA-Z] && "$SETUP_PASSWORD" =~ [0-9] ]] ||
  die "The owner password must be at least 12 characters and mix letters with digits."
# Production REQUIRES real SMTP for safe password-reset delivery — there is
# deliberately NO outbox bypass in the production lane.
while [[ -z "${SMTP_URL:-}" ]]; do
  read_var SMTP_URL "REQUIRED: SMTP relay URL (smtps://user:pass@host:465 or smtp://...:587 STARTTLS)"
done
smtp_proto=${SMTP_URL%%:*}
[[ "$smtp_proto" == smtp || "$smtp_proto" == smtps ]] ||
  die "SMTP_URL must be an smtp:// or smtps:// URL (production requires verified TLS)."
if [[ -n "${MAIL_FROM:-}" ]]; then
  sed -i -E "s|^MAIL_FROM=.*|MAIL_FROM=$MAIL_FROM|" "$ENV_FILE"
fi
sed -i -E "s|^SMTP_URL=.*|SMTP_URL=$SMTP_URL|" "$ENV_FILE"
grep -q "^MAIL_MODE=" "$ENV_FILE" &&
  sed -i -E "s|^MAIL_MODE=.*|MAIL_MODE=smtp|" "$ENV_FILE"
# Persist the tunnel token in the 0600-only file (never command arguments/logs).
if grep -q "^TUNNEL_TOKEN=" "$ENV_FILE"; then
  sed -i -E "s|^TUNNEL_TOKEN=.*|TUNNEL_TOKEN=$TUNNEL_TOKEN|" "$ENV_FILE"
else
  echo "TUNNEL_TOKEN=$TUNNEL_TOKEN" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

step "Validating the combined stack"
dc() { docker compose --env-file "$ENV_FILE" -p duka -f "$DOCKER_DIR/compose.yml" -f "cloudflare/compose.tunnel.yml" "$@"; }
PUBLIC_HOST="$PUBLIC_HOST" dc config --quiet

step "Building pinned images (first run takes several minutes)"
PUBLIC_HOST="$PUBLIC_HOST" dc --profile ops build api web migrate ops

step "Starting PostgreSQL and waiting for readiness"
PUBLIC_HOST="$PUBLIC_HOST" dc up -d db
attempts=0
until docker inspect --format '{{.State.Health.Status}}' duka-db-1 2>/dev/null | grep -q '^healthy$'; do
  sleep 2
  attempts=$((attempts + 1))
  ((attempts < 30)) || die "PostgreSQL did not become healthy; inspect 'docker compose logs db'."
done

step "Applying reviewed schema migrations (dedicated migrator role)"
PUBLIC_HOST="$PUBLIC_HOST" dc --profile ops run --rm migrate

step "Provisioning the first business ($SETUP_COMPANY / $SETUP_EMAIL)"
setup_log=/tmp/duka-setup.log.$$
setup_rc=0
PUBLIC_HOST="$PUBLIC_HOST" dc --profile ops run --rm \
  -e SETUP_COMPANY -e SETUP_EMAIL -e SETUP_PASSWORD \
  migrate artifacts/server/setup.mjs 2>&1 | tee "$setup_log" || setup_rc=$?
if ((setup_rc != 0)); then
  if grep -q SETUP_IDENTITY_EXISTS "$setup_log"; then
    echo "Business already existed; continuing (idempotent setup guard)."
    setup_rc=0
  else
    rm -f "$setup_log"
    unset SETUP_PASSWORD
    die "Provisioning the first business failed; inspect the output above and re-run when resolved."
  fi
elif grep -q SETUP_IDENTITY_EXISTS "$setup_log"; then
  echo "Business already existed; continuing (idempotent setup guard)."
fi
rm -f "$setup_log"
unset SETUP_PASSWORD

step "Starting the application and the Cloudflare Tunnel (no public ports)"
PUBLIC_HOST="$PUBLIC_HOST" dc up -d api web proxy tunnel
attempts=0
until docker inspect --format '{{.State.Health.Status}}' duka-api-1 2>/dev/null | grep -q '^healthy$'; do
  sleep 3
  attempts=$((attempts + 1))
  if ((attempts >= 40)); then
    echo "go-live: API did not become ready — sanitized recent API/tunnel log tail:" >&2
    PUBLIC_HOST="$PUBLIC_HOST" dc logs --tail=40 api 2>&1 |
      sed -E 's/(password|secret|token|key|smtp_url|passkey)([^ ]{0,8})["'"'']?[^ ,"'"'']+/\1***REDACTED***/gi' | tail -20 >&2
    PUBLIC_HOST="$PUBLIC_HOST" dc logs --tail=10 tunnel 2>&1 | tail -8 >&2
    die "Resolve the API error above (common first boots: SMTP_URL empty/invalid, insecure origin, migration mismatch), then re-run — the script resumes safely at the failed step."
  fi
done

step "Verifying end-to-end readiness"
PUBLIC_HOST="$PUBLIC_HOST" dc ps
if ! docker exec duka-proxy-1 curl -fsS http://web:3000/ >/dev/null 2>&1; then
  echo "go-live: web origin did not answer on the private network; check 'docker compose logs web'." >&2
fi
cat <<REPORT

==============================================================
 Duka Business OS is live behind the Cloudflare Tunnel.

 1. Cloudflare Zero Trust -> Networks -> Tunnels -> your tunnel:
    add a public hostname  $PUBLIC_HOST  ->  http://proxy:8080
    (this was the manual dashboard step the tunnel token encodes).
 2. Open https://$PUBLIC_HOST and sign in as $SETUP_EMAIL.
 3. First-run setup: the API readiness page lists what a fresh
    business still needs (tax PIN, receipt customization, payment
    methods, catalog, opening balances).
 4. Cloudflare hardening (required): bypass CDN caching for the
    whole host, disable Rocket Loader/HTML rewriting (breaks the
    nonce CSP), and never WAF-challenge the Daraja callback path.
 5. Store deploy/docker/secrets/backup.key and this env file
    independently offline; then run a backup + RESTORE rehearsal:
       dc() { docker compose --env-file deploy/docker/.env.production -p duka -f deploy/docker/compose.yml -f deploy/cloudflare/compose.tunnel.yml "\$@"; }
       dc logs tunnel   # confirms the tunnel is connected
       dc --profile ops run --rm ops artifacts/server/backup.mjs
==============================================================
REPORT
