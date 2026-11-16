#!/usr/bin/env bash
# Operate the e-commerce stack that lives INSIDE the Duka Compose project.
#
#   bash deploy/ecommerce/shop.sh status
#   bash deploy/ecommerce/shop.sh up            # build + start + migrate (safe to re-run)
#   bash deploy/ecommerce/shop.sh logs [service]
#   bash deploy/ecommerce/shop.sh migrate       # forward-only, reviewed migrations
#   bash deploy/ecommerce/shop.sh seed          # settings + first admin (needs ADMIN_BOOTSTRAP_*)
#   bash deploy/ecommerce/shop.sh backup        # encrypted custom-format dump + verification
#   bash deploy/ecommerce/shop.sh restore FILE  # decrypt + restore into the shop database
#   bash deploy/ecommerce/shop.sh psql          # interactive SQL as the shop role
#
# It reuses deploy/docker/.env.production and deploy/ecommerce/.env.shop; it
# never prints secret values, and it never touches the Duka (ERP) database.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
target=$(cd "$here/../.." && pwd)
docker_dir="$target/deploy/docker"
env_file="$docker_dir/.env.production"
shop_env="$here/.env.shop"
key_file="$here/secrets/shop-backup.key"
backup_dir="$here/backups"

die() { echo "shop: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
dc() { docker compose --env-file "$env_file" --env-file "$shop_env" -p duka \
  -f "$docker_dir/compose.yml" -f "$target/deploy/cloudflare/compose.tunnel.yml" \
  -f "$here/compose.shop.yml" "$@"; }

[[ -e "$env_file" ]] || die "no $env_file — install Duka with deploy/go-live.sh first"
[[ -e "$shop_env" ]] || die "no $shop_env — provision the shop with deploy/ecommerce/init-shop-env.sh"
docker ps >/dev/null 2>&1 || die "Docker is not reachable"
SHOP_PUBLIC_HOST=$(sed -n 's/^SHOP_PUBLIC_HOST=//p' "$shop_env" | head -n1)

wait_healthy() { # wait_healthy container attempts
  local container=$1 attempts=${2:-40} waited=0 status
  while :; do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo missing)
    [[ "$status" == healthy ]] && return 0
    ((waited < attempts)) || { echo "shop: $container is $status" >&2; return 1; }
    sleep 3
    waited=$((waited + 1))
  done
}

cmd=${1:-status}
shift || true
case "$cmd" in
  status)
    dc ps
    # This is the private health endpoint; it is not reachable from the internet
    # except through the storefront hostname.
    dc exec -T shop-api node -e \
      "fetch('http://127.0.0.1:4100/health/ready').then(async r=>{console.log('ready', r.status); process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
    ;;
  up)
    step "Building storefront images"
    dc --profile ops build shop-api shop-web
    step "Starting the storefront database"
    dc up -d shop-db
    wait_healthy duka-shop-db-1 30 || die "the storefront database did not become healthy"
    step "Applying storefront migrations"
    dc --profile ops run --rm shop-migrate
    step "Starting API, worker and web"
    dc up -d shop-api shop-worker shop-web proxy
    wait_healthy duka-shop-api-1 40 || die "the storefront API did not become healthy; check 'shop.sh logs shop-api'"
    wait_healthy duka-shop-web-1 40 || die "the storefront web app did not become healthy; check 'shop.sh logs shop-web'"
    echo "Storefront is up behind the proxy on host $SHOP_PUBLIC_HOST."
    ;;
  logs)
    dc logs --tail=100 "${1:-shop-api}"
    ;;
  migrate)
    dc --profile ops run --rm shop-migrate
    ;;
  seed)
    [[ -n "${ADMIN_BOOTSTRAP_EMAIL:-}" && -n "${ADMIN_BOOTSTRAP_PASSWORD:-}" ]] ||
      die "export ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD (12+ chars) for the first storefront administrator"
    dc --profile ops run --rm \
      -e ADMIN_BOOTSTRAP_EMAIL -e ADMIN_BOOTSTRAP_PASSWORD \
      shop-seed
    ;;
  backup)
    [[ -e "$key_file" ]] || die "missing $key_file (created by init-shop-env.sh); generate a new key only if you accept losing the ability to read older dumps"
    docker inspect duka-shop-db-1 >/dev/null 2>&1 || die "the storefront database is not running"
    mkdir -p "$backup_dir"
    chmod 700 "$backup_dir"
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    out="$backup_dir/shop-$stamp.dump.enc"
    step "Dumping the storefront database (custom format, encrypted with $key_file)"
    if ! dc exec -T shop-db pg_dump -U shop_app -Fc ecommerce |
      openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:"$key_file" -out "$out"; then
      rm -f "$out"
      die "the storefront dump failed; nothing was verified"
    fi
    chmod 600 "$out"
    step "Verifying the dump decrypts into a readable archive"
    if ! openssl enc -d -aes-256-cbc -pbkdf2 -pass file:"$key_file" -in "$out" |
      dc exec -T shop-db pg_restore --list >/dev/null; then
      die "the storefront dump did not verify; treat it as unusable and investigate"
    fi
    echo "Verified encrypted storefront dump: $out ($(du -h "$out" | cut -f1))"
    echo "Custody: this key is SEPARATE from deploy/docker/secrets/backup.key. Store both offline."
    ;;
  restore)
    file=${1:-}
    [[ -n "$file" && -e "$file" ]] || die "usage: shop.sh restore /path/to/shop-YYYYMMDDTHHMMSSZ.dump.enc"
    [[ -e "$key_file" ]] || die "missing $key_file; the dump cannot be decrypted without it"
    step "Restoring $file into the shop database (drops and recreates owned objects)"
    echo "This overwrites the current storefront data. Five seconds to abort (Ctrl-C)..."
    sleep 5
    openssl enc -d -aes-256-cbc -pbkdf2 -pass file:"$key_file" -in "$file" |
      dc exec -T shop-db pg_restore -U shop_app -d ecommerce --clean --if-exists --no-owner
    ;;
  psql)
    dc exec shop-db psql -U shop_app -d ecommerce
    ;;
  down)
    step "Stopping storefront containers (database volume is preserved)"
    dc stop shop-worker shop-web shop-api
    ;;
  *)
    die "unknown command '$cmd' (status|up|logs|migrate|seed|backup|restore|psql|down)"
    ;;
esac
