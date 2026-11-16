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
#   5. Provisions the e-commerce stack in the SAME Compose project: a dedicated
#      shop database/role/volume, its own images, migrations, first storefront
#      administrator and (optionally) read-only ERP integration.
#   6. Waits for readiness (ERP and storefront) and prints the checklist.
#
# Email delivery: password resets, invitations and alerts REQUIRE a real
# SMTP relay (smtps://user:pass@host:465 or smtp://...:587 STARTTLS). The API
# refuses to boot in production without one — this script enforces it up
# front; there is deliberately no outbox bypass in the production lane.
#
# Optional env overrides: TUNNEL_TOKEN, SETUP_COMPANY, SETUP_EMAIL,
# SETUP_PASSWORD, SMTP_URL, MAIL_FROM, PUBLIC_HOST, SHOP_PUBLIC_HOST,
# SHOP_ADMIN_EMAIL, SHOP_ADMIN_PASSWORD, SHOP_ERP_EMAIL, SHOP_ERP_PASSWORD,
# SHOP_ERP_BRANCH_ID, SHOP_ERP_WAREHOUSE_ID, SHOP_ERP_ENABLED. Interactive
# piped runs can export them all for a fully unattended roll-out.
set -euo pipefail
cd "$(dirname "$0")"
DOCKER_DIR="docker"
ENV_FILE="$DOCKER_DIR/.env.production"
# The e-commerce overlay lives beside its own generated configuration.
SHOP_DIR="ecommerce"
SHOP_ENV="$SHOP_DIR/.env.shop"
SHOP_OVERLAY="$SHOP_DIR/compose.shop.yml"
PUBLIC_HOST="${PUBLIC_HOST:-${1:-}}"

env_get() { sed -n "s/^$2=//p" "$1" | head -n1; }

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
if [[ "${TUNNEL_TOKEN_SKIP_CHECK:-0}" != "1" ]]; then
  [[ "$TUNNEL_TOKEN" =~ ^eyJ[A-Za-z0-9_-]{80,}={0,2}$ ]] ||
    die "The tunnel token should be ONE long base64 value from the Cloudflare dashboard (it starts with 'eyJ', contains no spaces/quotes/'.' separators and no 'cloudflared tunnel run --token' prefix). Copy ONLY the token value. Genuine tokens that ever fail this shape check can bypass it with TUNNEL_TOKEN_SKIP_CHECK=1 at your own risk."
fi
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

step "Preparing the e-commerce stack (same Compose project, separate database)"
SHOP_FIRST_RUN=0
if [[ -e "$SHOP_ENV" ]]; then
  SHOP_PUBLIC_HOST=$(env_get "$SHOP_ENV" SHOP_PUBLIC_HOST)
  [[ -n "$SHOP_PUBLIC_HOST" ]] || die "$SHOP_ENV has no SHOP_PUBLIC_HOST; restore it or delete the file deliberately and re-run."
  echo "Using existing $SHOP_ENV (mode 0600) for $SHOP_PUBLIC_HOST."
  echo "Storefront administrator and ERP credentials are not re-read on re-runs; see deploy/ecommerce/README.md to rotate them."
else
  SHOP_FIRST_RUN=1
  read_var SHOP_PUBLIC_HOST "Storefront hostname (a SECOND Cloudflare hostname, e.g. shop.$PUBLIC_HOST)" "shop.$PUBLIC_HOST"
  [[ "$SHOP_PUBLIC_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,63}$ ]] ||
    die "The storefront hostname must be a real public hostname you control in Cloudflare."
  [[ "$SHOP_PUBLIC_HOST" != "$PUBLIC_HOST" ]] ||
    die "The storefront needs its own hostname; it cannot share $PUBLIC_HOST with the ERP."
  read_var SHOP_ADMIN_EMAIL "Storefront administrator email" "$SETUP_EMAIL"
  read_var SHOP_ADMIN_PASSWORD "Storefront administrator password (12+ chars, letters and digits; NOT the ERP password)"
  [[ ${#SHOP_ADMIN_PASSWORD} -ge 12 && "$SHOP_ADMIN_PASSWORD" =~ [a-zA-Z] && "$SHOP_ADMIN_PASSWORD" =~ [0-9] ]] ||
    die "The storefront administrator password must be at least 12 characters and mix letters with digits."
  [[ "$SHOP_ADMIN_PASSWORD" != "$SETUP_PASSWORD" ]] ||
    die "Use a password for the storefront administrator that differs from the ERP owner password (separate identity realms)."

  # Read-only ERP integration. Without it the storefront catalogue stays empty
  # by design (this project never invents products or stock).
  read_var SHOP_ERP_EMAIL "ERP integration email for READ-ONLY catalogue/stock pulls (press Enter to leave the catalogue empty)" ""
  if [[ -n "${SHOP_ERP_EMAIL:-}" ]]; then
    SHOP_ERP_ENABLED=true
    read_var SHOP_ERP_PASSWORD "ERP integration password (hidden; the ERP user must not require an interactive MFA prompt)"
    [[ -n "${SHOP_ERP_PASSWORD:-}" ]] ||
      die "Provide the ERP integration password, or leave the ERP email blank to run the storefront without catalogue sync."
    read_var SHOP_ERP_BRANCH_ID "ERP branch id for stock reads (blank = ERP default)" ""
    read_var SHOP_ERP_WAREHOUSE_ID "ERP warehouse id for stock reads (blank = ERP default)" ""
  else
    SHOP_ERP_ENABLED=false
  fi
  SHOP_PAYMENTS_MODE=manual SHOP_ERP_ENABLED="$SHOP_ERP_ENABLED" \
  SHOP_ERP_EMAIL="${SHOP_ERP_EMAIL:-}" SHOP_ERP_PASSWORD="${SHOP_ERP_PASSWORD:-}" \
  SHOP_ERP_BRANCH_ID="${SHOP_ERP_BRANCH_ID:-}" SHOP_ERP_WAREHOUSE_ID="${SHOP_ERP_WAREHOUSE_ID:-}" \
    bash "$SHOP_DIR/init-shop-env.sh" "$SHOP_PUBLIC_HOST" "$PUBLIC_HOST"
  chmod 600 "$SHOP_ENV"
fi
unset SHOP_ERP_PASSWORD 2>/dev/null || true
SHOP_ADMIN_EMAIL="${SHOP_ADMIN_EMAIL:-}"

step "Validating the combined stack"
dc() { docker compose --env-file "$ENV_FILE" --env-file "$SHOP_ENV" -p duka -f "$DOCKER_DIR/compose.yml" -f "cloudflare/compose.tunnel.yml" -f "$SHOP_OVERLAY" "$@"; }
PUBLIC_HOST="$PUBLIC_HOST" dc config --quiet

step "Building pinned images (first run takes several minutes)"
PUBLIC_HOST="$PUBLIC_HOST" dc --profile ops build api web migrate ops shop-api shop-web

step "Starting PostgreSQL and waiting for readiness"
PUBLIC_HOST="$PUBLIC_HOST" dc up -d db
attempts=0
until docker inspect --format '{{.State.Health.Status}}' duka-db-1 2>/dev/null | grep -q '^healthy$'; do
  sleep 2
  attempts=$((attempts + 1))
  ((attempts < 30)) || die "PostgreSQL did not become healthy; inspect 'docker compose logs db'."
done

step "Starting the storefront database and applying its migrations"
PUBLIC_HOST="$PUBLIC_HOST" dc up -d shop-db
attempts=0
until docker inspect --format '{{.State.Health.Status}}' duka-shop-db-1 2>/dev/null | grep -q '^healthy$'; do
  sleep 2
  attempts=$((attempts + 1))
  ((attempts < 30)) || die "The storefront database did not become healthy; inspect 'docker compose logs shop-db'."
done
PUBLIC_HOST="$PUBLIC_HOST" dc --profile ops run --rm shop-migrate

step "Applying reviewed ERP schema migrations (dedicated migrator role)"
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

if [[ "$SHOP_FIRST_RUN" == "1" && -n "${SHOP_ADMIN_PASSWORD:-}" ]]; then
  step "Provisioning the storefront administrator ($SHOP_ADMIN_EMAIL)"
  # Passed BY NAME (values come from the exported environment), so the
  # administrator password never appears in `ps` or in shell history.
  ADMIN_BOOTSTRAP_EMAIL="$SHOP_ADMIN_EMAIL" ADMIN_BOOTSTRAP_PASSWORD="$SHOP_ADMIN_PASSWORD" \
    PUBLIC_HOST="$PUBLIC_HOST" dc --profile ops run --rm \
      -e ADMIN_BOOTSTRAP_EMAIL -e ADMIN_BOOTSTRAP_PASSWORD \
      shop-seed
  unset SHOP_ADMIN_PASSWORD 2>/dev/null || true
else
  step "Storefront administrator already provisioned; skipping bootstrap (idempotent guard)"
fi

step "Starting the application, the storefront and the Cloudflare Tunnel (no public ports)"
PUBLIC_HOST="$PUBLIC_HOST" dc up -d api web shop-api shop-worker shop-web proxy tunnel
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

attempts=0
until docker inspect --format '{{.State.Health.Status}}' duka-shop-api-1 2>/dev/null | grep -q '^healthy$'; do
  sleep 3
  attempts=$((attempts + 1))
  if ((attempts >= 40)); then
    echo "go-live: the storefront API did not become ready — sanitized recent log tail:" >&2
    PUBLIC_HOST="$PUBLIC_HOST" dc logs --tail=40 shop-api 2>&1 |
      sed -E 's/(password|secret|token|key|passkey)([^ ]{0,8})["'"'"']?[^ ,"'"'"']+/\1***REDACTED***/gi' | tail -20 >&2
    die "Resolve the storefront API error above, then re-run — the script resumes safely at the failed step."
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
 5. Cloudflare: add a SECOND public hostname  $SHOP_PUBLIC_HOST
    ->  http://proxy:8080  (same tunnel, same origin service). The
    storefront is routed by hostname, never by path, so the ERP stays
    untouched. Sign in at https://$SHOP_PUBLIC_HOST/admin as
    ${SHOP_ADMIN_EMAIL:-the storefront administrator}.
 6. Catalogue: the storefront starts EMPTY on purpose. If ERP integration
    is enabled, an operator triggers a pull from
    https://$SHOP_PUBLIC_HOST/admin (or the documented admin endpoints);
    stock and prices are read from the ERP, never written back.
 7. Payments stay manual in this release (no live Daraja provider); a
    captured payment must be recorded deliberately.
 8. Store deploy/docker/secrets/backup.key, .env.production and
    deploy/ecommerce/.env.shop independently offline; then run a backup +
    RESTORE rehearsal:
       dc() { docker compose --env-file deploy/docker/.env.production --env-file deploy/ecommerce/.env.shop -p duka -f deploy/docker/compose.yml -f deploy/cloudflare/compose.tunnel.yml -f deploy/ecommerce/compose.shop.yml "\$@"; }
       dc logs tunnel   # confirms the tunnel is connected
       dc --profile ops run --rm ops artifacts/server/backup.mjs
       # The shop database is separate: back it up on its own schedule
       dc exec -T shop-db pg_dump -U shop_app ecommerce > shop-$(date +%F).sql
==============================================================
REPORT
