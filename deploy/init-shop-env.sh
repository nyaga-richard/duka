#!/usr/bin/env bash
# Generate the storefront configuration ONCE (mode 0600), next to this script.
#
#   ERP_DIR=/opt/duka bash deploy/init-shop-env.sh shop.your-domain.example [erp-host]
#
# The ERP checkout is `../duka` by default, or wherever ERP_DIR points; the
# configuration and the shop's own Compose overlay live here, in the shop repo.
#
# erp-host defaults to PUBLIC_HOST in the ERP's deploy/docker/.env.production. It is the
# origin the shop API presents to Duka's origin allowlist for server-to-server
# (read-only) ERP calls; the shop API still authenticates with its own ERP user.
#
# Refuses to overwrite an existing .env.shop. Never prints a secret value.
# Optional env overrides: SHOP_PAYMENTS_MODE, SHOP_ERP_ENABLED, SHOP_ERP_EMAIL,
# SHOP_ERP_PASSWORD, SHOP_ERP_BRANCH_ID, SHOP_ERP_WAREHOUSE_ID, SHOP_LOG_LEVEL.
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
stage=$(cd "$here/.." && pwd)
env_file="$here/.env.shop"

erp_dir=${ERP_DIR:-$stage/../duka}
if [[ ! -d "$erp_dir" ]]; then
  echo "No ERP checkout at $erp_dir: clone nyaga-richard/duka beside this repo, or set ERP_DIR." >&2
  exit 1
fi
erp_dir=$(cd "$erp_dir" && pwd)

shop_host=${1:-}
if [[ ! "$shop_host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,63}$ ]]; then
  echo 'Usage: ./init-shop-env.sh shop.your-domain.example [erp-host]' >&2
  exit 1
fi

erp_host=${2:-}
if [[ -z "$erp_host" && -e "$erp_dir/deploy/docker/.env.production" ]]; then
  erp_host=$(sed -n 's/^PUBLIC_HOST=//p' "$erp_dir/deploy/docker/.env.production" | head -n1)
fi
if [[ -z "$erp_host" ]]; then
  echo 'No ERP host: pass it as the second argument (the Duka PUBLIC_HOST).' >&2
  exit 1
fi
if [[ ! "$erp_host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,63}$ ]]; then
  echo "ERP host '$erp_host' is not a valid hostname." >&2
  exit 1
fi
if [[ "$shop_host" == "$erp_host" ]]; then
  echo 'The shop host must differ from the ERP host; they are routed as separate Caddy sites.' >&2
  exit 1
fi

if [[ -e "$env_file" ]]; then
  echo 'Refusing to overwrite the existing .env.shop (delete it deliberately to re-provision).' >&2
  exit 1
fi

# Separate encryption key for storefront database dumps (never the Duka key).
if [[ -e "$here/secrets/shop-backup.key" ]]; then
  echo "Refusing to overwrite the existing storefront backup key at $here/secrets/shop-backup.key." >&2
  exit 1
fi
mkdir -p "$here/secrets"
chmod 700 "$here/secrets"
openssl rand -base64 32 > "$here/secrets/shop-backup.key"
chmod 600 "$here/secrets/shop-backup.key"

db_password=$(openssl rand -hex 24)
erp_enabled=${SHOP_ERP_ENABLED:-false}
if [[ "$erp_enabled" != "true" && "$erp_enabled" != "false" ]]; then
  echo 'SHOP_ERP_ENABLED must be true or false.' >&2
  exit 1
fi

tmp=$(mktemp "$here/.env.shop.XXXXXX")
cat > "$tmp" <<ENV
# Storefront operator configuration for the Duka stack. Never commit, never
# paste into a ticket or support log. Consumed by deploy/compose.shop.yml as both
# a Compose interpolation source and a container env_file.
SHOP_PUBLIC_HOST=$shop_host

# Where THIS checkout is, for the ERP's Compose to resolve the shop's build
# context (deploy/shop.sh exports the same value at run time).
SHOP_REPO_DIR=$stage

# Dedicated database, role and volume: the shop never shares Duka's database.
# shop-db is created with role shop_app / database ecommerce (constants in
# compose.shop.yml); only the password and the resulting URL are generated.
SHOP_DB_PASSWORD=$db_password
SHOP_DATABASE_URL=postgresql://shop_app:$db_password@shop-db:5432/ecommerce

# Phase 1 payment boundary: manual/deliberate capture only.
SHOP_PAYMENTS_MODE=${SHOP_PAYMENTS_MODE:-manual}

# READ-ONLY ERP integration (catalogue and stock pulls). Leave disabled until
# the ERP user below can authenticate without an interactive MFA challenge.
SHOP_ERP_ENABLED=$erp_enabled
SHOP_ERP_BASE_URL=${SHOP_ERP_BASE_URL:-http://api:4000}
SHOP_ERP_EMAIL=${SHOP_ERP_EMAIL:-}
SHOP_ERP_PASSWORD=${SHOP_ERP_PASSWORD:-}
SHOP_ERP_BRANCH_ID=${SHOP_ERP_BRANCH_ID:-}
SHOP_ERP_WAREHOUSE_ID=${SHOP_ERP_WAREHOUSE_ID:-}

SHOP_LOG_LEVEL=${SHOP_LOG_LEVEL:-info}
ENV
chmod 600 "$tmp"
mv -n "$tmp" "$env_file"
rm -f "$tmp"
chmod 600 "$env_file"
echo "Created $env_file (mode 0600): shop host $shop_host, dedicated database 'ecommerce', ERP integration ${erp_enabled}."
echo 'Store this file and secrets/shop-backup.key with the same care as .env.production: they hold the shop database password, any ERP user secret, and the separate dump key.'
