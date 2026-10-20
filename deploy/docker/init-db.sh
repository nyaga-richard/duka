#!/usr/bin/env bash
set -euo pipefail
# Runs only during explicit initialization of a NEW PostgreSQL volume.
# Existing databases/roles are never reset by application startup.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
 -v migrator_pw="$MIGRATION_DB_PASSWORD" -v app_pw="$DB_PASSWORD" \
 -v backup_pw="$BACKUP_DB_PASSWORD" -v restore_pw="$RESTORE_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE duka_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOREPLICATION PASSWORD %L', :'migrator_pw') \gexec
SELECT format('CREATE ROLE duka_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD %L', :'app_pw') \gexec
SELECT format('CREATE ROLE duka_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOREPLICATION PASSWORD %L', :'backup_pw') \gexec
SELECT format('CREATE ROLE duka_restore LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD %L', :'restore_pw') \gexec
ALTER DATABASE duka OWNER TO duka_migrator;
REVOKE ALL ON DATABASE duka FROM PUBLIC;
GRANT CONNECT ON DATABASE duka TO duka_app,duka_backup;
ALTER SCHEMA public OWNER TO duka_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO duka_app,duka_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE duka_migrator IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO duka_app;
ALTER DEFAULT PRIVILEGES FOR ROLE duka_migrator IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO duka_app;
ALTER DEFAULT PRIVILEGES FOR ROLE duka_migrator IN SCHEMA public GRANT SELECT ON TABLES TO duka_backup;
-- duka_restore owns only disposable recovery databases, not the business DB.
SQL
