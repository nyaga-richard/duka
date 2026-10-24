#!/usr/bin/env bash
# Idempotent sandbox revival for the Duka workspace.
# Rebuilds whatever a sandbox recreation destroyed; skips whatever survived.
set -euo pipefail

ROOT=/home/user/restored-workspace
NODE24=/home/user/tools/node24
BACKUP_ENC="backups/duka-2026-10-18T15-20-25.161Z-3bb7983e.enc"
WORKSPACE_BUILD_DIR=.cache/next-workspace-r3
export PATH="$NODE24/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive
export DEMO_MODE=true
export BACKUP_PASSPHRASE_FILE=/home/user/.env.backup-key.local
cd "$ROOT"
say() { printf '\n=== %s ===\n' "$*"; }

# --- 0. Node 24 runtime (normally persisted under ~/tools) -------------------
if ! "$NODE24/bin/node" --version 2>/dev/null | grep -q '^v24\.'; then
  say "install Node 24.22.0"
  mkdir -p "$NODE24"
  curl -fsSL https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz -o /tmp/node24.tar.xz
  tar -xJf /tmp/node24.tar.xz -C "$NODE24" --strip-components=1
  rm -f /tmp/node24.tar.xz
fi
npm --version 2>/dev/null | grep -qx '10.8.2' || npm install -g npm@10.8.2 --no-fund --no-audit
echo "node $(node --version), npm $(npm --version)"

# --- 1. npm dependencies (node_modules is always wiped) ----------------------
if [ ! -x node_modules/.bin/tsx ]; then
  say "npm ci"
  npm ci --no-audit --no-fund
else
  echo "node_modules present - skip"
fi
# Built server artifacts (always pruned on recreation) — restore step needs unpack-backup.mjs.
if [ ! -f artifacts/server/unpack-backup.mjs ]; then
  say "build server artifacts"
  npm run build:server
fi

# --- 2. PostgreSQL 17 service ------------------------------------------------
if ! command -v psql >/dev/null; then
  say "install PostgreSQL 17"
  sudo apt-get update -qq
  sudo apt-get install -y -qq postgresql-17 postgresql-client-17
fi
pg_isready -q -h 127.0.0.1 -p 5432 || {
  sudo service postgresql start >/dev/null 2>&1 || sudo pg_ctlcluster 17 main start >/dev/null 2>&1 || true
}
for i in $(seq 1 20); do pg_isready -q -h 127.0.0.1 -p 5432 && break; sleep 1; done
psql --version

# --- 3. Role + databases (plain unprivileged dev role; readiness forbids more)
DBPW=$(python3 -c "import re,urllib.parse as p; e=dict(re.findall(r'^([A-Z_]+)=(.*)\$', open('.env').read(), re.M)); print(p.urlparse(e['DATABASE_URL']).password)")
say "ensure role duka + databases"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='duka'" | grep -q 1 || {
  printf "CREATE ROLE duka LOGIN PASSWORD '%s';\n" "${DBPW//\'/\'\'}" > /tmp/duka-role.sql
  chmod 644 /tmp/duka-role.sql
  sudo -u postgres psql -q -f /tmp/duka-role.sql
  rm -f /tmp/duka-role.sql
}
for db in duka duka_test; do
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
    || sudo -u postgres createdb -O duka "$db"
done

# --- 4. Restore newest snapshot into an EMPTY duka database only --------------
# Emptiness must be judged by the privileged cluster role: FORCE RLS hides all
# company rows from the runtime role and would fake an empty database.
if sudo -u postgres psql -d duka -tAc "SELECT 1 FROM companies LIMIT 1" 2>/dev/null | grep -q 1; then
  echo "business data present - restore skipped (never overwrites an existing db)"
else
  say "decrypt + restore snapshot (empty db)"
  chmod 600 "$BACKUP_PASSPHRASE_FILE"
  stage=$(mktemp -d /home/user/.duka-restore-XXXXXX)
  node artifacts/server/unpack-backup.mjs "$BACKUP_ENC" "$stage/recovery" > /dev/null
  PGPASSWORD="$DBPW" pg_restore --no-owner --no-privileges --exit-on-error --single-transaction \
    -h 127.0.0.1 -U duka -d duka "$stage/recovery/database.dump"
  mkdir -m 700 -p /home/user/duka-uploads
  cp -a "$stage/recovery/uploads/." /home/user/duka-uploads/
  chmod -R go-rwx /home/user/duka-uploads
  rm -rf "$stage"
  echo "restored; plaintext staging purged"
fi

# --- 4.5 Forward migrations newer than the snapshot ---------------------------
# Snapshots cap at their creation-time migration. Apply any pending ones.
# Migration 023 backfills system accounts per company and must therefore see
# through FORCE RLS: run its data backfill with the privileged cluster role,
# never the runtime role (which would silently insert zero rows).
if [ -n "${MIGRATE_022PLUS:-}" ] || \
   ! sudo -u postgres psql -d duka -tAc \
     "SELECT 1 FROM schema_migrations WHERE name='023_asset_lifecycle_expense_corrections.sql'" 2>/dev/null | grep -q 1; then
  say "db migrate (pending forward migrations)"
  npm run db:migrate
  say "privileged data backfills (RLS-invisible rows)"
  sudo -u postgres psql -d duka -v ON_ERROR_STOP=1 <<'EOF'
INSERT INTO accounts(company_id,code,name,type,system_key)
 SELECT c.id,'4950','Gain on disposal of assets','income','asset_disposal_gain' FROM companies c
  WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.system_key='asset_disposal_gain')
   AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.code='4950');
INSERT INTO accounts(company_id,code,name,type,system_key)
 SELECT c.id,'4950A','Gain on disposal of assets','income','asset_disposal_gain' FROM companies c
  WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.system_key='asset_disposal_gain');
INSERT INTO accounts(company_id,code,name,type,system_key)
 SELECT c.id,'6300','Loss on disposal of assets','expense','asset_disposal_loss' FROM companies c
  WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.system_key='asset_disposal_loss')
   AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.code='6300');
INSERT INTO accounts(company_id,code,name,type,system_key)
 SELECT c.id,'6300A','Loss on disposal of assets','expense','asset_disposal_loss' FROM companies c
  WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.system_key='asset_disposal_loss');
EOF
fi

# --- 4.6 Privileged backfills that runtime-role migrations cannot see ----------
# 028 grants sales.credit to seeded Cashier roles, but roles are FORCE RLS and
# migrate.ts runs as the runtime role, which sees zero rows here. Production is
# covered because duka_migrator has BYPASSRLS; sandboxes need this privileged,
# idempotent replay. (Keep in sync with database/migrations/028.)
sudo -u postgres psql -d duka -v ON_ERROR_STOP=1 <<'EOF'
INSERT INTO role_permissions(company_id, role_id, permission)
SELECT company_id, id, 'sales.credit' FROM roles WHERE name = 'Cashier'
ON CONFLICT DO NOTHING;
EOF
# 029 route-sales grants (same FORCE-RLS pitfall; keep in sync with 029).
if sudo -u postgres psql -d duka -tAc "SELECT 1 FROM schema_migrations WHERE name='029_route_sales.sql'" 2>/dev/null | grep -q 1; then
  sudo -u postgres psql -d duka -v ON_ERROR_STOP=1 <<'EOF'
INSERT INTO role_permissions(company_id, role_id, permission)
SELECT r.company_id, r.id, p.permission FROM roles r
CROSS JOIN (VALUES ('routes.read'), ('routes.manage'), ('routes.shift')) AS p(permission)
WHERE r.name IN ('Business owner','General manager','Branch manager')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(company_id, role_id, permission)
SELECT r.company_id, r.id, p.permission FROM roles r
CROSS JOIN (VALUES ('routes.read'), ('routes.shift'), ('sales.create'), ('sales.credit'), ('shifts.open'), ('payments.receive')) AS p(permission)
WHERE r.name = 'Salesperson'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(company_id, role_id, permission)
SELECT r.company_id, r.id, 'routes.read' FROM roles r
WHERE r.name = 'Accountant'
ON CONFLICT DO NOTHING;
EOF
else
  echo "029 not migrated yet - privileged role grants skipped (will run on next revive)"
fi

# --- 5. Documented demo identity (seed refuses an existing owner) -------------
if sudo -u postgres psql -d duka -tAc "SELECT 1 FROM identities WHERE email='owner@duka.test'" 2>/dev/null | grep -q 1; then
  echo "demo owner present - seed skipped"
else
  say "db:demo (DEMO_MODE=$DEMO_MODE, MPESA_MODE=${MPESA_MODE:-mock})"
  npm run db:demo
fi
unset DBPW

# --- 6. Workspace frontend build (.cache is wiped on recreation) --------------
if [ ! -f "apps/web/$WORKSPACE_BUILD_DIR/standalone/apps/web/server.js" ]; then
  say "workspace frontend build ($WORKSPACE_BUILD_DIR)"
  WORKSPACE_BUILD_DIR="$WORKSPACE_BUILD_DIR" npm run workspace:build
else
  echo "workspace build present - skip"
fi

# --- 7. Secret/script permissions persist; re-assert defensively --------------
chmod 600 .env .env.* 2>/dev/null || true
chmod 755 scripts/*.sh 2>/dev/null || true

say "REVIVAL COMPLETE"
echo "Start supervised processes next:"
echo "  WORKSPACE_PREVIEW=true npm run dev:api        # port 4000"
echo "  WORKSPACE_BUILD_DIR=$WORKSPACE_BUILD_DIR npm run workspace:web   # port 3000"
