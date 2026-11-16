#!/usr/bin/env bash
# Duka Business OS — one-command upgrade, for checkouts you update with git pull.
# Deployments are never rebuilt from scratch: current images are tagged for
# instant rollback, schema moves forward-only via the dedicated migrator, and
# a self-check gate guards the swap.
#
# On the deployed server (the standard operator workflow):
#
#   cd /opt/duka
#   sudo bash deploy/update.sh                 # git fetch + fast-forward pull, then upgrade
#   sudo bash deploy/update.sh --ref v0.2.0    # or pin to a reviewed tag/commit (checkout, never reset --hard)
#
# Zip/offline deployments can still refresh without a remote:
#
#   sudo bash deploy/update.sh --src /path/to/new-release
#
# Behaviour, in order:
#   1. Validates the EXISTING deployment (env file, compose stack, healthy db).
#   2. Updates the source: git fetch + fast-forward pull (default on hosts
#      with .git; refuses a dirty tree or non-fast-forward), or an rsync copy
#      from --src that preserves the 0600 env, backup key and all runtime
#      volumes (never --delete). RELEASE = short git sha (or UTC timestamp
#      for gitless zip targets).
#   3. Runs a verified encrypted backup with the existing ops role
#      (skip with --skip-backup only if a VERY recent verified backup exists).
#   4. Tags the running images ':previous', builds new images.
#   5. Applies reviewed forward-only migrations, then swaps ONLY api+web
#      containers (db, volumes, proxy and the tunnel stay untouched).
#   6. If the e-commerce overlay is provisioned (deploy/ecommerce/.env.shop),
#      backs up the shop database, applies its forward-only migrations and
#      swaps ONLY its api/worker/web containers, with the same ':previous'
#      rollback stash and health gate.
#   7. Health gate: on failure, re-tags ':previous' back and restores the old
#      containers automatically before failing loudly.
#   8. deploy/self-check.sh acceptance gate against the live HTTPS host (it
#      also checks the storefront host when one is provisioned).
#
# Options: --skip-backup, --no-self-check, --src PATH, --ref REF.
# Rollback is always available after a successful update too:
#   docker tag duka-api:previous duka-api:local && docker tag duka-web:previous duka-web:local
#   # set RELEASE=local in deploy/docker/.env.production, then the usual 'dc up -d api web'
set -euo pipefail
SRC=""
REF=""
RUN_BACKUP=1
RUN_SELFCHECK=1
while (($#)); do
  case "$1" in
    --src) SRC=${2:?--src requires a release path}; shift 2;;
    --ref) REF=${2:?--ref requires a tag/branch/commit}; shift 2;;
    --skip-backup) RUN_BACKUP=0; shift;;
    --no-self-check) RUN_SELFCHECK=0; shift;;
    *) echo "update: unknown argument '$1'" >&2; exit 2;;
  esac
done
TARGET=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_DIR="$TARGET/deploy/docker"
ENV_FILE="$DOCKER_DIR/.env.production"
# E-commerce overlay: same Compose project, separate database and images.
SHOP_ENV="$TARGET/deploy/ecommerce/.env.shop"
SHOP_OVERLAY="$TARGET/deploy/ecommerce/compose.shop.yml"
SHOP_ENV_ARGS=()
SHOP_FILE_ARGS=()
SHOP_ENABLED=0
shop_enabled() { [[ "$SHOP_ENABLED" == 1 ]]; }
die() { echo "update: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

step "Validating the existing deployment"
[[ -e "$ENV_FILE" ]] || die "no private configuration at $ENV_FILE — this is an upgrade path, use deploy/go-live.sh for first installation"
[[ -e "$DOCKER_DIR/compose.yml" && -e "$TARGET/deploy/cloudflare/compose.tunnel.yml" ]] || die "compose assets missing under $TARGET"
docker ps >/dev/null 2>&1 || die "Docker is not reachable"
docker inspect duka-db-1 >/dev/null 2>&1 || die "the running database container duka-db-1 was not found; is the right -p duka project up?"
DB_HEALTH=$(docker inspect --format '{{.State.Health.Status}}' duka-db-1)
[[ "$DB_HEALTH" == healthy ]] || die "the database is $DB_HEALTH; never upgrade on top of an unhealthy database"
shop_args() {
  SHOP_ENV_ARGS=()
  SHOP_FILE_ARGS=()
  SHOP_ENABLED=0
  [[ -e "$SHOP_ENV" ]] || return 0
  [[ -e "$SHOP_OVERLAY" ]] || die "the e-commerce configuration exists but $SHOP_OVERLAY is missing; restore the new release and re-run"
  SHOP_ENV_ARGS=(--env-file "$SHOP_ENV")
  SHOP_FILE_ARGS=(-f "$SHOP_OVERLAY")
  SHOP_ENABLED=1
}
shop_args
dc() {
  docker compose --env-file "$ENV_FILE" ${SHOP_ENV_ARGS[@]+"${SHOP_ENV_ARGS[@]}"} \
    -p duka -f "$DOCKER_DIR/compose.yml" -f "$TARGET/deploy/cloudflare/compose.tunnel.yml" \
    ${SHOP_FILE_ARGS[@]+"${SHOP_FILE_ARGS[@]}"} "$@"
}
PUBLIC_HOST=$(grep -E '^PUBLIC_HOST=' "$ENV_FILE" | cut -d= -f2-)
[[ "$PUBLIC_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,63}$ ]] || die "PUBLIC_HOST missing from the env file"
export PUBLIC_HOST
dc config --quiet
if shop_enabled; then
  SHOP_PUBLIC_HOST=$(sed -n 's/^SHOP_PUBLIC_HOST=//p' "$SHOP_ENV" | head -n1)
  [[ "$SHOP_PUBLIC_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,63}$ ]] ||
    die "SHOP_PUBLIC_HOST missing from $SHOP_ENV; restore it from your protected copy"
  docker inspect duka-shop-db-1 >/dev/null 2>&1 ||
    die "the e-commerce database container duka-shop-db-1 was not found; run deploy/go-live.sh or deploy/ecommerce/shop.sh up first"
  SHOP_DB_HEALTH=$(docker inspect --format '{{.State.Health.Status}}' duka-shop-db-1)
  [[ "$SHOP_DB_HEALTH" == healthy ]] || die "the e-commerce database is $SHOP_DB_HEALTH; never upgrade on top of an unhealthy database"
  echo "storefront: https://$SHOP_PUBLIC_HOST (separate database duka-shop-db-1)"
fi
echo "target: $TARGET  host: https://$PUBLIC_HOST"

if [[ -z "$SRC" && -e "$TARGET/.git" ]]; then
  step "Updating source with git (fast-forward only)"
  git=$(command -v git) || die "git is required for the pull flow (or use --src)"
  BEFORE=$("$git" -C "$TARGET" rev-parse --short=12 HEAD)
  dirty=$("$git" -C "$TARGET" status --porcelain | grep -v '^??' || true)
  [[ -z "$dirty" ]] || die "working tree has uncommitted tracked changes; commit or stash them first:\n$dirty"
  "$git" -C "$TARGET" fetch --prune origin
  if [[ -n "$REF" ]]; then
    "$git" -C "$TARGET" checkout --quiet "$REF" ||
      die "could not check out '$REF'"
  else
    "$git" -C "$TARGET" pull --ff-only ||
      die "fast-forward pull failed; inspect history divergence (never overwrite production source blindly)"
  fi
  AFTER=$("$git" -C "$TARGET" rev-parse --short=12 HEAD)
  RELEASE="$AFTER"
  echo "source: $BEFORE -> $AFTER"
  [[ "$BEFORE" == "$AFTER" && -z "$REF" ]] && echo "already up to date; still verifying and re-applying release steps (idempotent)"
elif [[ -z "$SRC" ]]; then
  die "the target is not a git checkout ($TARGET has no .git). Supply a new release path with --src /path/to/release"
else
  step "Refreshing source from $SRC (private config/secrets preserved)"
  [[ -d "$SRC/apps" && -d "$SRC/packages" && -e "$SRC/package.json" ]] || die "--src '$SRC' is not a Duka release checkout (expected apps/, packages/, package.json)"
  SRC=$(cd "$SRC" && pwd)
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude 'release' --exclude 'node_modules' --exclude '.cache' --exclude 'artifacts' \
      --exclude 'deploy/docker/.env.production' --exclude 'deploy/docker/secrets' \
      --exclude 'deploy/ecommerce/.env.shop' --exclude 'deploy/ecommerce/secrets' \
      --exclude 'deploy/ecommerce/backups' --exclude '.git' \
      "$SRC/" "$TARGET/"
  else
    (cd "$SRC" && tar --exclude=release --exclude=node_modules --exclude=.cache --exclude=artifacts \
        --exclude=deploy/docker/.env.production --exclude=deploy/docker/secrets \
        --exclude=deploy/ecommerce/.env.shop --exclude=deploy/ecommerce/secrets \
        --exclude=deploy/ecommerce/backups --exclude=.git -cf - .) |
      (cd "$TARGET" && tar -xf -)
  fi
  RELEASE=$(cd "$TARGET" && git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%dT%H%M%SZ)
fi
[[ -e "$ENV_FILE" && -e "$TARGET/deploy/docker/secrets/backup.key" ]] || die "private configuration or backup key lost during refresh — stop and restore from your protected copies"
# The NEW source may itself change compose/compose-tunnel/the shop overlay —
# re-validate with the operator's env before building anything.
shop_args
dc config --quiet || die "the updated source's compose stack no longer validates with the private env — stop and reconcile before any image is touched"
echo "release: $RELEASE"

if ((RUN_BACKUP)); then
  step "Encrypted backup of database + uploads (ops role, same key custody)"
  if ! dc --profile ops run --rm ops artifacts/server/backup.mjs; then
    echo "update: backup FAILED. Upgrading without a verified backup is unsafe." >&2
    die "re-run with --skip-backup only if a very recent verified backup already exists"
  fi
  if shop_enabled; then
    echo "Backing up the e-commerce database too (separate key custody)."
    if ! bash "$TARGET/deploy/ecommerce/shop.sh" backup; then
      echo "update: the storefront backup FAILED. Refusing to migrate the shop without a verified dump." >&2
      die "re-run with --skip-backup only if a very recent verified storefront dump already exists"
    fi
  fi
else
  step "Skipping backup at operator request (--skip-backup)"
fi

step "Tagging current images for instant rollback"
ROLLBACK_IMAGES=(duka-api duka-web duka-ops)
if shop_enabled; then ROLLBACK_IMAGES+=(duka-shop-api duka-shop-web); fi
for name in "${ROLLBACK_IMAGES[@]}"; do
  image_id=$(docker image inspect -f '{{.Id}}' "${name}:local" 2>/dev/null || true)
  if [[ -n "$image_id" ]]; then
    docker tag "$image_id" "${name}:previous"
  fi
done

step "Building new images ($RELEASE)"
sed -i -E "s|^RELEASE=.*|RELEASE=$RELEASE|" "$ENV_FILE"
if shop_enabled; then
  dc --profile ops build api web migrate ops shop-api shop-web
else
  dc --profile ops build api web migrate ops
fi

step "Applying forward-only reviewed migrations"
dc --profile ops run --rm migrate
if shop_enabled; then
  dc --profile ops run --rm shop-migrate
fi

step "Swapping application containers only (databases, volumes and the tunnel stay untouched)"
if shop_enabled; then
  # proxy is recreated only when its configuration (Caddyfile/env/networks)
  # changed, which is how the storefront host route reaches the new stack.
  dc up -d api web shop-api shop-worker shop-web proxy
else
  dc up -d api web
fi

step "Health gate"
attempts=0
until [[ "$(docker inspect --format '{{.State.Health.Status}}' duka-api-1 2>/dev/null || echo restarting)" == healthy ]]; do
  sleep 3
  attempts=$((attempts + 1))
  if ((attempts >= 40)); then
    echo "update: new API failed health — rolling back to ':previous'" >&2
    for name in "${ROLLBACK_IMAGES[@]}"; do
      if docker image inspect "${name}:previous" >/dev/null 2>&1; then
        docker tag "${name}:previous" "${name}:local"
      fi
    done
    sed -i -E "s|^RELEASE=.*|RELEASE=local|" "$ENV_FILE"
    if shop_enabled; then
      dc up -d api web shop-api shop-worker shop-web || true
    else
      dc up -d api web || true
    fi
    die "rolled back to the previous images. Investigate with 'docker compose logs api'."
  fi
done

if shop_enabled; then
  step "Storefront health gate"
  attempts=0
  until [[ "$(docker inspect --format '{{.State.Health.Status}}' duka-shop-api-1 2>/dev/null || echo restarting)" == healthy ]]; do
    sleep 3
    attempts=$((attempts + 1))
    if ((attempts >= 40)); then
      echo "update: the new storefront API failed health — rolling back to ':previous'" >&2
      for name in "${ROLLBACK_IMAGES[@]}"; do
        if docker image inspect "${name}:previous" >/dev/null 2>&1; then
          docker tag "${name}:previous" "${name}:local"
        fi
      done
      sed -i -E "s|^RELEASE=.*|RELEASE=local|" "$ENV_FILE"
      dc up -d api web shop-api shop-worker shop-web || true
      die "rolled back ERP and storefront images. Investigate with 'docker compose logs shop-api'."
    fi
  done
fi

if [[ $RUN_SELFCHECK -eq 1 ]]; then
  step "Self-check against the live hosts"
  if shop_enabled; then
    SHOP_HOST="$SHOP_PUBLIC_HOST" bash "$TARGET/deploy/self-check.sh" "$PUBLIC_HOST"
  else
    bash "$TARGET/deploy/self-check.sh" "$PUBLIC_HOST"
  fi
fi

cat <<REPORT

==============================================================
 Upgrade complete at https://$PUBLIC_HOST ($RELEASE)

 - Running images: duka-api:$RELEASE duka-web:$RELEASE
 - Rollback stash: duka-api:previous duka-web:previous
   instant revert: tag ':previous' images back to ':local',
   set RELEASE=local in $ENV_FILE, then
   dc() { docker compose --env-file deploy/docker/.env.production -p duka \\
     -f deploy/docker/compose.yml -f deploy/cloudflare/compose.tunnel.yml "\$@"; }
   dc up -d api web
 - First-run setup state is visible to owners at https://$PUBLIC_HOST/setup
REPORT

if shop_enabled; then
  cat <<REPORT
 - Storefront: https://$SHOP_PUBLIC_HOST ($RELEASE)
   images duka-shop-api:$RELEASE duka-shop-web:$RELEASE
   rollback stash duka-shop-api:previous duka-shop-web:previous
   the shop database (duka-shop-db-1) was migrated forward-only and was
   backed up before the migration; it is a SEPARATE database from Duka's.
REPORT
fi

cat <<REPORT
==============================================================
REPORT
