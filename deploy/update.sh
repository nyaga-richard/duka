#!/usr/bin/env bash
# Duka Business OS — one-command upgrade. Deployments are never rebuilt from
# scratch: current images are tagged for instant rollback, schema moves
# forward-only via the dedicated migrator, and a self-check gate guards go-live.
#
# Usage (as the operator, on the host):
#
#   sudo bash /path/to/new-release/deploy/update.sh --src /path/to/new-release /opt/duka
#   # or, inside a checked-out release:  sudo bash deploy/update.sh --src . /opt/duka
#
# Behaviour, in order:
#   1. Verifies the EXISTING deployment (env file, compose stack, healthy db).
#   2. Copies the new release source over the target (preserving private env,
#      secrets, and all runtime volumes; never --delete).
#   3. Runs a verified encrypted backup with the existing ops role
#      (skip with --skip-backup only if a VERY recent verified backup exists).
#   4. Builds new images tagged RELEASE=<gitsha|timestamp>; the currently
#      running images are tagged 'previous' first.
#   5. Applies reviewed forward-only migrations, then swaps ONLY api+web
#      containers (db, volumes, proxy and the tunnel stay untouched).
#   6. Waits for API health; on failure it re-tags 'previous' back and
#      restores the old containers automatically before failing loudly.
#   7. Runs deploy/self-check.sh (public HTTPS checks against the live host)
#      and prints image tags + rollback instructions on success.
#
# Rollback is always available after a successful update too:
#   docker compose --env-file deploy/docker/.env.production -p duka \
#     -f deploy/docker/compose.yml -f deploy/cloudflare/compose.tunnel.yml \
#     up -d api web   # after: docker tag duka-api:previous duka-api:local, same for web
#
# Options: --skip-backup, --no-self-check. Env: RELEASE overrides the tag.
set -euo pipefail
SRC=""
TARGET=""
RUN_BACKUP=1
RUN_SELFCHECK=1
while (($#)); do
  case "$1" in
    --src) SRC=${2:?--src requires the new release path}; shift 2;;
    --skip-backup) RUN_BACKUP=0; shift;;
    --no-self-check) RUN_SELFCHECK=0; shift;;
    *) if [[ -z "$TARGET" && -d "$1" ]]; then TARGET=$1; shift
       else echo "update: unknown argument '$1'" >&2; exit 2; fi;;
  esac
done
[[ -n "$TARGET" && -n "$SRC" ]] || {
  cat <<USAGE >&2
usage: bash deploy/update.sh --src /path/to/new-release /opt/duka [--skip-backup] [--no-self-check]
USAGE
  exit 2
}
TARGET=$(cd "$TARGET" && pwd); SRC=$(cd "$SRC" && pwd)
DOCKER_DIR="$TARGET/deploy/docker"
ENV_FILE="$DOCKER_DIR/.env.production"
die() { echo "update: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

step "Validating the existing deployment"
[[ -e "$ENV_FILE" ]] || die "no private configuration at $ENV_FILE — this is an upgrade path, use deploy/go-live.sh for first installation"
[[ -e "$DOCKER_DIR/compose.yml" && -e "$TARGET/deploy/cloudflare/compose.tunnel.yml" ]] || die "compose assets missing under $TARGET"
[[ -d "$SRC/apps" && -d "$SRC/packages" && -e "$SRC/package.json" ]] || die "--src '$SRC' is not a Duka release checkout (expected apps/, packages/, package.json)"
docker ps >/dev/null 2>&1 || die "Docker is not reachable"
docker inspect duka-db-1 >/dev/null 2>&1 || die "the running database container duka-db-1 was not found; is the right -p duka project up?"
DB_HEALTH=$(docker inspect --format '{{.State.Health.Status}}' duka-db-1)
[[ "$DB_HEALTH" == healthy ]] || die "the database is $DB_HEALTH; never upgrade on top of an unhealthy database"
dc() { docker compose --env-file "$ENV_FILE" -p duka -f "$DOCKER_DIR/compose.yml" -f "$TARGET/deploy/cloudflare/compose.tunnel.yml" "$@"; }
PUBLIC_HOST=$(grep -E '^PUBLIC_HOST=' "$ENV_FILE" | cut -d= -f2-)
[[ "$PUBLIC_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,63}$ ]] || die "PUBLIC_HOST missing from the env file"
export PUBLIC_HOST
dc config --quiet
echo "target: $TARGET  host: https://$PUBLIC_HOST"

step "Refreshing source onto the deployment (private config/secrets preserved)"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude 'release' --exclude 'node_modules' --exclude '.cache' --exclude 'artifacts' \
    --exclude 'deploy/docker/.env.production' --exclude 'deploy/docker/secrets' --exclude '.git' \
    "$SRC/" "$TARGET/"
else
  (cd "$SRC" && tar --exclude=release --exclude=node_modules --exclude=.cache --exclude=artifacts \
      --exclude=deploy/docker/.env.production --exclude=deploy/docker/secrets --exclude=.git -cf - .) |
    (cd "$TARGET" && tar -xf -)
fi
[[ -e "$ENV_FILE" && -e "$TARGET/deploy/docker/secrets/backup.key" ]] || die "private configuration or backup key lost during refresh — stop and restore from your protected copies"

RELEASE="${RELEASE:-$(cd "$TARGET" && git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%dT%H%M%SZ)}"
echo "new release tag: $RELEASE"

attempt_backup() {
  step "Encrypted backup of database + uploads (ops role, same key custody)"
  if ! dc --profile ops run --rm ops artifacts/server/backup.mjs; then
    echo "update: backup FAILED. Upgrading without a verified backup is unsafe." >&2
    die "re-run with --skip-backup only if a very recent verified backup already exists"
  fi
}
((RUN_BACKUP)) && attempt_backup || step "Skipping backup at operator request (--skip-backup)"

step "Tagging current images for instant rollback"
for name in duka-api duka-web duka-ops; do
  image_id=$(docker image inspect -f '{{.Id}}' "${name}:local" 2>/dev/null || true)
  if [[ -n "$image_id" ]]; then
    docker tag "$image_id" "${name}:previous"
  fi
done

step "Building new images ($RELEASE)"
sed -i -E "s|^RELEASE=.*|RELEASE=$RELEASE|" "$ENV_FILE"
dc --profile ops build api web migrate ops

step "Applying forward-only reviewed migrations"
dc --profile ops run --rm migrate

step "Swapping api + web containers only (db, volumes, proxy, tunnel untouched)"
dc up -d api web

step "Health gate"
attempts=0
until [[ "$(docker inspect --format '{{.State.Health.Status}}' duka-api-1 2>/dev/null || echo restarting)" == healthy ]]; do
  sleep 3
  attempts=$((attempts + 1))
  if ((attempts >= 40)); then
    echo "update: new API failed health — rolling back to :previous" >&2
    for name in duka-api duka-web; do
      if docker image inspect "${name}:previous" >/dev/null 2>&1; then
        docker tag "${name}:previous" "${name}:local"
      fi
    done
    sed -i -E "s|^RELEASE=.*|RELEASE=local|" "$ENV_FILE"
    dc up -d api web || true
    die "rolled back to the previous images. Investigate with 'docker compose logs api'."
  fi
done

if [[ $RUN_SELFCHECK -eq 1 ]]; then
  step "Self-check against the live host (https://$PUBLIC_HOST)"
  bash "$TARGET/deploy/self-check.sh" "$PUBLIC_HOST"
fi

cat <<REPORT

==============================================================
 Upgrade complete at https://$PUBLIC_HOST ($RELEASE)

 - Running images: duka-api:$RELEASE duka-web:$RELEASE
 - Rollback stash: duka-api:previous duka-web:previous
   (instant revert: docker tag duka-api:previous duka-api:local;
    same for web; set RELEASE=local in the env file; then
    dc() { docker compose --env-file deploy/docker/.env.production -p duka \\
      -f deploy/docker/compose.yml -f deploy/cloudflare/compose.tunnel.yml "\$@"; }\\
    dc up -d api web)
 - Actual first-run setup state is visible to owners at https://$PUBLIC_HOST/setup
==============================================================
REPORT
