#!/usr/bin/env bash
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
host=${1:-}
if [[ ! "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,63}$ ]]; then echo 'Usage: ./init-env.sh pos.your-domain.example' >&2; exit 1; fi
if [[ -e "$here/.env.production" || -e "$here/secrets/backup.key" ]]; then echo 'Refusing to overwrite existing production configuration or recovery keys.' >&2; exit 1; fi
mkdir -p "$here/secrets"
chmod 700 "$here/secrets"
openssl rand -base64 32 > "$here/secrets/backup.key"
chmod 600 "$here/secrets/backup.key"
cat > "$here/.env.production" <<ENV
# Private operator configuration. Never commit, copy into images, or send in support logs.
PUBLIC_HOST=$host
RELEASE=local
POSTGRES_PASSWORD=$(openssl rand -hex 24)
MIGRATION_DB_PASSWORD=$(openssl rand -hex 24)
DB_PASSWORD=$(openssl rand -hex 24)
BACKUP_DB_PASSWORD=$(openssl rand -hex 24)
RESTORE_DB_PASSWORD=$(openssl rand -hex 24)
MFA_ENCRYPTION_KEY=$(openssl rand -base64 32)
MPESA_CALLBACK_SECRET=$(openssl rand -hex 32)
MPESA_MODE=disabled
MPESA_BASE_URL=https://api.safaricom.co.ke
ETIMS_MODE=disabled
MAIL_MODE=smtp
# REQUIRED for real email (password resets/invitations/alerts): verified-TLS
# relay (smtps://...:465 or smtp://...:587 with STARTTLS). go-live.sh flips
# MAIL_MODE=outbox for a first boot without a relay; sending then stays
# database-queued until this is a real relay and mail is verified.
SMTP_URL=
MAIL_FROM=no-reply@$host
# Only for the optional Cloudflare Tunnel override; never expose this token in logs.
TUNNEL_TOKEN=
ENV
chmod 600 "$here/.env.production"
echo 'Created private configuration and a SEPARATE backup key. Set SMTP_URL; store the MFA and backup keys independently offline. No database was touched.'
