# Deploying nao to Databricks Apps + Lakebase

This target runs nao as a **Databricks App** with its metadata DB on **Lakebase**
(managed Postgres), querying **Databricks SQL warehouse / Unity Catalog** data,
and using **Databricks Model Serving** (Claude) as the LLM.

## How it fits together

```
Databricks App "nao"  (managed Node 22 + Python 3.11 runtime)
  command: bash deploy/databricks/start.sh
    ├─ FastAPI sidecar (text-to-SQL)            127.0.0.1:8005   (internal)
    └─ nao backend (Bun, Fastify; UI + tRPC)    0.0.0.0:$DATABRICKS_APP_PORT
  resources:
    ├─ lakebase            → PG* env → DB_URI    (metadata / chat history)
    ├─ sql-warehouse       → DATABRICKS_WAREHOUSE_ID  (analytics data)
    ├─ serving-endpoint    → Claude FM API       (LLM)
    └─ better-auth-secret  → BETTER_AUTH_SECRET
```

- **app.yaml** and **requirements.txt** live at the **repo root** (Apps discovers
  them there). They are thin: app.yaml's `command` calls `deploy/databricks/start.sh`,
  and root `requirements.txt` does `-r deploy/databricks/requirements.txt`.
- **start.sh** orchestrates both processes (there is no supervisord on Apps),
  builds `DB_URI` from the Lakebase `PG*` vars, derives the warehouse `http_path`,
  and mints an app-SP OAuth token for the data connection.
- **Bun**: nao's backend is hard-coupled to Bun (`bun:sqlite`, `Bun.main`). The
  Apps runtime has Node but not Bun, so the root `package.json` adds the `bun`
  npm package; `npm install` vendors the binary into `node_modules/.bin` and
  start.sh runs the backend with it.

## One-time infra setup

Run the setup script once (provisions durable, stable credentials — a native
Postgres role + dedicated `nao` database + a long-lived token — and stores the
app secrets). This avoids the ~1h OAuth-token expiry that otherwise degrades the
app after an hour:

```bash
PROFILE=<cli-profile> INSTANCE=nao-db ADMIN_USER=<you@databricks.com> \
  bash deploy/databricks/setup.sh
```

Then attach the app resources (`sql-warehouse`, `serving-endpoint`, `lakebase`,
and the `better-auth-secret` / `pg-password` / `databricks-token` secrets) and
deploy.

## One-time setup gotchas (learned in practice)

- **Lakebase `public` schema grant.** Postgres 15+ doesn't grant `CREATE` on
  `public` by default, so nao's first migration fails with `permission denied for
schema public`. As a Lakebase admin, grant the app SP (its Postgres role name is
  the SP **client id**):
  `sql
    GRANT CREATE, USAGE ON SCHEMA public TO "<app-sp-client-id>";
    `
  (Connect with `psql` using a token from `databricks database generate-database-credential`.)
- **Stable `BETTER_AUTH_SECRET`.** Must be a fixed secret, not ephemeral — Better
  Auth encrypts its JWKS with it and stores them in Lakebase. A changing secret
  causes `Failed to decrypt private key` on every request (login loop). Create one:
    ```bash
    databricks secrets create-scope nao
    databricks secrets put-secret nao better_auth_secret --string-value "$(openssl rand -hex 32)"
    ```
    and attach it as the `better-auth-secret` app resource.
- **No separate login (SSO passthrough).** With `NAO_SSO_PASSTHROUGH=true`, nao
  trusts Databricks Apps' `X-Forwarded-Email` and auto-creates a session, so the
  Databricks SSO is the only login. Leave it off if the app isn't behind an
  authenticating proxy.

## Prerequisites

- `databricks` CLI authenticated to the target workspace (e.g. `databricks auth login --profile logfood`).
- A **Lakebase** database instance.
- A **SQL warehouse** (serverless recommended).
- A **Model Serving** endpoint for Claude (Foundation Model API), e.g. `databricks-claude-sonnet-4-5`.
- A secret scope `nao` with key `better_auth_secret` (`openssl rand -hex 32`).
- The frontend prebuilt: `apps/frontend/dist` present (CI builds it — see `.github/workflows`).

## Deploy

### Option A — Asset Bundle (repeatable)

```bash
databricks bundle validate -t logfood
databricks bundle deploy   -t logfood \
  --var="warehouse_id=<id>" --var="lakebase_name=<instance>"
databricks bundle run nao  -t logfood
```

### Option B — CLI (first manual pass)

```bash
databricks apps create nao -p logfood
databricks sync . "/Workspace/Users/$(whoami)/nao" -p logfood \
  --exclude node_modules --exclude .git
databricks apps deploy nao \
  --source-code-path "/Workspace/Users/$(whoami)/nao" -p logfood
# then attach the lakebase / sql-warehouse / serving-endpoint / secret resources
# to the app and grant the app service principal:
#   CAN USE on the warehouse, SELECT on target UC tables,
#   CAN QUERY on the serving endpoint, connect+create on Lakebase.
databricks apps logs nao -p logfood   # watch [SYSTEM]/[APP] boot lines
```

## Configuration (env)

| Var                                                | Source                            | Purpose                                                        |
| -------------------------------------------------- | --------------------------------- | -------------------------------------------------------------- |
| `PG*`                                              | lakebase resource                 | assembled into `DB_URI` (Postgres) by start.sh                 |
| `DB_SSL=true`                                      | app.yaml                          | Lakebase requires TLS                                          |
| `DATABRICKS_WAREHOUSE_ID`                          | sql-warehouse resource            | → `http_path` for the data connection                          |
| `DATABRICKS_HOST`                                  | platform                          | bare host for the data connection                              |
| `DATABRICKS_TOKEN`                                 | minted at boot (SP OAuth)         | data-connection bearer token (or set a PAT secret to override) |
| `NAO_DATABRICKS_CATALOG` / `NAO_DATABRICKS_SCHEMA` | app.yaml (optional)               | scope the analytics catalog/schema                             |
| `NAO_DATABRICKS_LLM_ENDPOINT`                      | app.yaml                          | served Claude endpoint name                                    |
| `BETTER_AUTH_SECRET`                               | better-auth-secret resource       | stable sessions                                                |
| `BETTER_AUTH_URL`                                  | derived from `DATABRICKS_APP_URL` | auth callbacks                                                 |

## Known limitations (v1)

- **OAuth token expiry (~1h).** The data-connection token and the Lakebase
  password are short-lived. v1 mints them at boot; long-running sessions can
  fail after ~1h. Enhancement: patch `cli/nao_core/config/databases/databricks.py`
  to use `databricks-sql-connector`'s OAuth `credentials_provider` (auto-refresh),
  and add a Lakebase password refresher.
- **Chromium / KVM absent.** Chart-image export (puppeteer/Chromium) and Boxlite
  sandboxing (`/dev/kvm`) don't run on Apps. The core NL→SQL→in-browser-chart
  path is unaffected.
- **Auth layering.** Databricks Apps OAuth gates the app; nao's Better Auth sits
  behind it (v1 runs single-tenant). Per-user identity / OBO is a later step.
- **Build egress.** The Apps build downloads native prebuilds (better-sqlite3,
  duckdb, resvg, ripgrep, bun). The workspace must allow build-time egress.
