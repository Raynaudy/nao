#!/usr/bin/env bash
# =============================================================================
# One-time Databricks infrastructure setup for the nao app.
# =============================================================================
# Provisions the durable, stable credentials the app uses (so nothing depends on
# ~1h OAuth tokens), and the secrets the app reads. Idempotent — safe to re-run.
#
# Prerequs: `databricks` CLI authenticated to the target workspace, `psql`, and
# admin rights on the Lakebase instance. Run AFTER the Lakebase instance + SQL
# warehouse + serving endpoint exist.
#
# Usage:
#   PROFILE=fe-vm-nao-demo INSTANCE=nao-db ADMIN_USER=you@databricks.com \
#     bash deploy/databricks/setup.sh
#
# Then attach these app resources (UI or DAB) and deploy:
#   sql-warehouse, serving-endpoint, lakebase,
#   secrets: better-auth-secret, pg-password, databricks-token
# -----------------------------------------------------------------------------
set -euo pipefail

PROFILE="${PROFILE:?set PROFILE=<databricks cli profile>}"
INSTANCE="${INSTANCE:-nao-db}"
ADMIN_USER="${ADMIN_USER:?set ADMIN_USER=<your databricks email>}"
SCOPE="${SCOPE:-nao}"
PG_ROLE="${PG_ROLE:-nao_app}"
PG_DB="${PG_DB:-nao}"
PAT_LIFETIME_SECONDS="${PAT_LIFETIME_SECONDS:-7776000}" # 90 days

db() { databricks "$@" -p "$PROFILE"; }

echo "==> Enabling Postgres native login on $INSTANCE"
db database update-database-instance "$INSTANCE" enable_pg_native_login --enable-pg-native-login >/dev/null

HOST="$(db database get-database-instance "$INSTANCE" -o json | python3 -c 'import sys,json;print(json.load(sys.stdin)["read_write_dns"])')"
ADMIN_TOKEN="$(db database generate-database-credential --json "{\"instance_names\":[\"$INSTANCE\"]}" -o json | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')"
PG_PASSWORD="$(openssl rand -hex 24)"

echo "==> Creating native role '$PG_ROLE' + database '$PG_DB' owned by it"
PGPASSWORD="$ADMIN_TOKEN" psql "host=$HOST port=5432 dbname=databricks_postgres user=$ADMIN_USER sslmode=require" \
	-v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='$PG_ROLE') THEN
    CREATE ROLE $PG_ROLE LOGIN PASSWORD '$PG_PASSWORD';
  ELSE
    ALTER ROLE $PG_ROLE WITH LOGIN PASSWORD '$PG_PASSWORD';
  END IF;
END \$\$;
GRANT $PG_ROLE TO "$ADMIN_USER" WITH SET TRUE;
SELECT 'CREATE DATABASE $PG_DB OWNER $PG_ROLE'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='$PG_DB')\gexec
GRANT CREATE ON DATABASE $PG_DB TO $PG_ROLE;
SQL

echo "==> Creating a long-lived PAT for the warehouse + LLM connections"
PAT="$(db tokens create --lifetime-seconds "$PAT_LIFETIME_SECONDS" --comment "nao-app" -o json | python3 -c 'import sys,json;print(json.load(sys.stdin)["token_value"])')"

echo "==> Storing secrets in scope '$SCOPE'"
db secrets create-scope "$SCOPE" 2>/dev/null || true
db secrets put-secret "$SCOPE" better_auth_secret --string-value "$(openssl rand -hex 32)"
db secrets put-secret "$SCOPE" pg_password --string-value "$PG_PASSWORD"
db secrets put-secret "$SCOPE" databricks_token --string-value "$PAT"

echo "==> Done. Secrets in scope '$SCOPE': better_auth_secret, pg_password, databricks_token"
echo "    Next: attach app resources (incl. those secrets) and deploy (see README)."
