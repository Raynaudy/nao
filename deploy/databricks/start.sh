#!/usr/bin/env bash
# =============================================================================
# nao — Databricks Apps entrypoint
# =============================================================================
# Databricks Apps run a single `command` (argv, not a shell) against synced
# source on a managed Node 22 + Python 3.11 runtime. This script is that single
# command (invoked as: command: ["bash", "deploy/databricks/start.sh"]).
#
# It orchestrates the two nao processes that the Docker image normally runs
# under supervisord — there is no supervisor on Apps:
#   1. Python FastAPI sidecar (text-to-SQL)         -> 127.0.0.1:$FASTAPI_PORT
#   2. nao backend (Fastify, serves UI + tRPC API)  -> 0.0.0.0:$DATABRICKS_APP_PORT
#
# The backend is hard-coupled to Bun (bun:sqlite, Bun.main), which is NOT in the
# Apps runtime, so we run it with the Bun binary vendored via the `bun` npm
# package (installed into node_modules/.bin at build time). See deploy/README.md.
# -----------------------------------------------------------------------------
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_ROOT"

# Make the vendored bun + workspace bins resolvable.
export PATH="$APP_ROOT/node_modules/.bin:$PATH"
export NODE_ENV="${NODE_ENV:-production}"
export HOME="${HOME:-/home/app}"
# Resolve an ABSOLUTE interpreter path. Apps launches the venv python via a
# relative PATH entry, so even sys.executable can be relative (.venv/bin/python)
# and breaks once we cd elsewhere (e.g. the sync runs from /tmp/nao-project).
# os.path.abspath resolves it against the current dir ($APP_ROOT).
PY="$(python -c 'import os,sys; print(os.path.abspath(sys.executable))' 2>/dev/null \
   || python3 -c 'import os,sys; print(os.path.abspath(sys.executable))' 2>/dev/null \
   || command -v python3 || command -v python)"
case "$PY" in /*) ;; *) PY="$APP_ROOT/$PY" ;; esac  # belt-and-suspenders
export NAO_PYTHON="$PY"  # used by the backend's data-sync trigger / scheduled job
echo "Interpreter: $PY"

# --- Web port: Apps assigns it dynamically; nao reads SERVER_PORT / --port -----
PORT="${DATABRICKS_APP_PORT:-8000}"
export SERVER_PORT="$PORT"
export FASTAPI_PORT="${FASTAPI_PORT:-8005}"

# --- Context source -----------------------------------------------------------
# The fork's source is synced to the workspace, so the nao project context can
# live in the repo (no runtime git clone / egress). Defaults to the bundled
# Databricks context; override with NAO_CONTEXT_SOURCE=git + NAO_CONTEXT_GIT_*.
export NAO_CONTEXT_SOURCE="${NAO_CONTEXT_SOURCE:-local}"
export NAO_DEFAULT_PROJECT_PATH="${NAO_DEFAULT_PROJECT_PATH:-$APP_ROOT/deploy/databricks/context}"

echo "=== nao on Databricks Apps ==="
echo "App root:     $APP_ROOT"
echo "Context:      $NAO_CONTEXT_SOURCE @ $NAO_DEFAULT_PROJECT_PATH"
echo "Web port:     $PORT"
echo "FastAPI port: $FASTAPI_PORT"

# --- Database: build DB_URI from Lakebase-injected vars if not set ------------
# nao maps DB_URI starting with postgres:// to the Postgres dialect; DB_SSL maps
# to ssl=require (Lakebase requires TLS). The Lakebase resource injects PGHOST/
# PGPORT/PGDATABASE/PGUSER (var names vary); the password is an OAuth credential
# the app SP mints (Lakebase has no static password). We log which PG vars are
# present (names only) to make the wiring observable.
echo "Lakebase env present: $(env | grep -oE '^(PG[A-Z]*|DATABRICKS_DATABASE[A-Z_]*)=' | tr -d '=' | sort | tr '\n' ' ')"
if [[ -z "${DB_URI:-}" && -n "${PGHOST:-}" ]]; then
  PGPORT="${PGPORT:-5432}"
  PGDATABASE="${PGDATABASE:-databricks_postgres}"
  PGUSER="${PGUSER:-${DATABRICKS_CLIENT_ID:-}}"
  # Mint a Lakebase OAuth token for the password if none was injected.
  if [[ -z "${PGPASSWORD:-}" && -n "${DATABRICKS_DATABASE_INSTANCE:-}" ]]; then
    PGPASSWORD="$("$PY" deploy/databricks/mint_token.py --lakebase "$DATABRICKS_DATABASE_INSTANCE" 2>/dev/null || true)"
  fi
  if [[ -n "${PGUSER:-}" && -n "${PGPASSWORD:-}" ]]; then
    export DB_URI="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"
    echo "DB_URI built from Lakebase env (host=$PGHOST db=$PGDATABASE user set, pw set)"
  else
    echo "WARNING: incomplete Lakebase credentials (user set: ${PGUSER:+yes}, pw set: ${PGPASSWORD:+yes})"
  fi
fi
export DB_SSL="${DB_SSL:-true}"

if [[ "${DB_URI:-}" != postgres* ]]; then
  echo "WARNING: DB_URI is not Postgres — nao will fall back to ephemeral SQLite," \
       "which does NOT persist on the Apps ephemeral filesystem. Attach a Lakebase resource."
fi

# --- Auth ----------------------------------------------------------------------
# BETTER_AUTH_URL must be the public app URL (set via app.yaml env, populated
# from the DATABRICKS_APP_URL the platform injects). BETTER_AUTH_SECRET should be
# a stable app secret so sessions survive restarts.
if [[ -n "${DATABRICKS_APP_URL:-}" && -z "${BETTER_AUTH_URL:-}" ]]; then
  export BETTER_AUTH_URL="$DATABRICKS_APP_URL"
fi
if [[ -z "${BETTER_AUTH_SECRET:-}" ]]; then
  echo "WARNING: BETTER_AUTH_SECRET not set — generating ephemeral secret (sessions won't persist)."
  export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
fi

# --- Databricks data source (warehouse) ---------------------------------------
# nao's Databricks connector wants bare host + http_path + a bearer token. The
# context's nao_config.yaml reads these via {{ env(...) }}. We derive them from
# the platform-injected DATABRICKS_HOST + the SQL warehouse resource, and mint a
# short-lived OAuth token for the app service principal.
# Normalize the workspace host: Apps may inject DATABRICKS_HOST with or without
# a scheme. Build a scheme-qualified URL (for the LLM base URL) and a bare host
# (for nao's warehouse server_hostname).
if [[ -n "${DATABRICKS_HOST:-}" ]]; then
  HOST_URL="$DATABRICKS_HOST"
  [[ "$HOST_URL" == http*://* ]] || HOST_URL="https://$HOST_URL"
  HOST_URL="${HOST_URL%/}"
  export DATABRICKS_HOST_CLEAN="${HOST_URL#https://}"
  export DATABRICKS_HOST_CLEAN="${DATABRICKS_HOST_CLEAN#http://}"
  # LLM via Databricks Model Serving (OpenAI-compatible chat API). The
  # `databricks` provider reads DATABRICKS_TOKEN (apiKey) + DATABRICKS_LLM_BASE_URL.
  export DATABRICKS_LLM_BASE_URL="${DATABRICKS_LLM_BASE_URL:-${HOST_URL}/serving-endpoints}"
  echo "Databricks host=$DATABRICKS_HOST_CLEAN  LLM base=$DATABRICKS_LLM_BASE_URL"
fi
if [[ -n "${DATABRICKS_WAREHOUSE_ID:-}" ]]; then
  export NAO_DATABRICKS_HTTP_PATH="/sql/1.0/warehouses/${DATABRICKS_WAREHOUSE_ID}"
fi
# Mint an app-SP OAuth token for the data connection (valid ~1h). See README for
# the auto-refresh enhancement (patching the connector to use a credentials
# provider). A pre-set DATABRICKS_TOKEN (e.g. a PAT secret) takes precedence.
if [[ -z "${DATABRICKS_TOKEN:-}" ]]; then
  if DATABRICKS_TOKEN="$("$PY" deploy/databricks/mint_token.py 2>/dev/null)"; then
    export DATABRICKS_TOKEN
    echo "Minted app-SP OAuth token for Databricks data connection."
  else
    echo "WARNING: could not mint a Databricks OAuth token; data queries may fail."
  fi
fi

# --- Sync data context (schema metadata) --------------------------------------
# `nao sync` introspects the configured databases and writes the context tree
# (columns/profiling/description/preview per table) the agent reads. The deployed
# source is read-only, so copy the project to a writable dir (stable path → same
# project record across restarts) and sync there. Non-fatal: if it fails the
# agent still introspects live via SQL.
if [[ "${NAO_CONTEXT_SOURCE:-local}" == "local" && -f "$NAO_DEFAULT_PROJECT_PATH/nao_config.yaml" ]]; then
  WRITABLE_CTX="${NAO_WRITABLE_CONTEXT:-/tmp/nao-project}"
  mkdir -p "$WRITABLE_CTX"
  cp -R "$NAO_DEFAULT_PROJECT_PATH/." "$WRITABLE_CTX/"
  # Pre-create the output dir: nao sync's cleanup step iterdir()s `databases/`
  # without an existence check and errors on a fresh project otherwise.
  mkdir -p "$WRITABLE_CTX/databases"
  export NAO_DEFAULT_PROJECT_PATH="$WRITABLE_CTX"
  echo "=== Syncing data context into $WRITABLE_CTX ==="
  # Invoke via the module (entry point `nao` may not be on PATH); show output.
  ( cd "$WRITABLE_CTX" && "$PY" -m nao_core.main sync -p databases ) \
    || echo "WARNING: nao sync failed (see above); agent will fall back to live SQL introspection."
fi

# Note: `cli.ts serve` runs Drizzle migrations itself before listening, so no
# separate migrate step is needed here.

# --- FastAPI sidecar (internal only) ------------------------------------------
echo "=== Starting FastAPI sidecar on 127.0.0.1:$FASTAPI_PORT ==="
export PYTHONPATH="$APP_ROOT:${PYTHONPATH:-}"
"$PY" -m uvicorn apps.backend.fastapi.main:app \
  --host 127.0.0.1 --port "$FASTAPI_PORT" &
FASTAPI_PID=$!

# Stop the sidecar if the backend exits.
trap 'kill "$FASTAPI_PID" 2>/dev/null || true' EXIT

# --- nao backend (foreground, owns the public port) ---------------------------
echo "=== Starting nao backend on 0.0.0.0:$PORT ==="
exec bun run apps/backend/src/cli.ts serve --port "$PORT"
