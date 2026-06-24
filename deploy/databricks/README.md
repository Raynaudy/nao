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
    ├─ lakebase            → PGHOST/PGPORT       (metadata / chat history)
    ├─ sql-warehouse       → DATABRICKS_WAREHOUSE_ID  (analytics data)
    ├─ serving-endpoint    → Claude FM API       (LLM)
    ├─ better-auth-secret  → BETTER_AUTH_SECRET
    ├─ pg-password         → Lakebase native-role password (stable)
    └─ databricks-token    → long-lived token for warehouse + LLM (stable)
```

- **app.yaml** and **requirements.txt** live at the **repo root** (Apps discovers
  them there). They are thin: app.yaml's `command` calls `deploy/databricks/start.sh`,
  and root `requirements.txt` does `-r deploy/databricks/requirements.txt`.
- **start.sh** orchestrates both processes (there is no supervisord on Apps).
  It builds `DB_URI` for Lakebase using a **dedicated native Postgres role
  (`nao_app`) + database (`nao`)** authenticated with a **stable password**
  (`pg-password` secret), derives the warehouse `http_path`, and uses a
  **long-lived `DATABRICKS_TOKEN`** (`databricks-token` secret) for both the
  warehouse data connection and the LLM. These stable credentials avoid the
  ~1h expiry of boot-minted OAuth tokens. (`mint_token.py` remains a fallback
  when the secrets aren't set.)
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

## Design notes (why it's set up this way)

- **Durable credentials, not boot-minted OAuth.** The Lakebase OAuth token,
  warehouse token, and LLM token all expire ~1h, which used to break the app
  after an hour. Instead `setup.sh` provisions a **native Postgres role
  (`nao_app`) owning a dedicated `nao` database** (full schema control, stable
  password) and a **long-lived token** for the warehouse + LLM. The app SP role
  is Databricks-managed and can't take a native password, hence the dedicated
  role. A dedicated database also avoids `permission denied` clashes with the
  SP-owned objects in the default `databricks_postgres` DB.
- **Stable `BETTER_AUTH_SECRET`.** Better Auth encrypts its JWKS with it and
  stores them in Lakebase; an ephemeral secret causes `Failed to decrypt private
key` on every request (login loop). `setup.sh` creates a stable one.
- **No separate login (SSO passthrough).** With `NAO_SSO_PASSTHROUGH=true`, nao
  trusts Databricks Apps' `X-Forwarded-Email` and auto-creates a session, so the
  Databricks SSO is the only login. Leave it off if the app isn't behind an
  authenticating proxy.
- **Writable analytics schema.** nao creates temp volumes/tables, so point it at
  a catalog/schema the app can write to (`temp_schema`) — a read-only catalog
  like `samples` fails with `User does not have ... CREATE VOLUME`.

## Prerequisites

- `databricks` CLI authenticated to the target workspace.
- A **Lakebase** database instance, a **SQL warehouse** (serverless recommended),
  and a **Model Serving** endpoint for Claude (e.g. `databricks-claude-sonnet-4-5`).
- Run **`setup.sh`** (above) — it creates the `nao_app` role + `nao` DB and the
  `better_auth_secret` / `pg_password` / `databricks_token` secrets.
- The frontend prebuilt: `apps/frontend/dist` present (CI builds it — see `.github/workflows`).

## Deploy

### Option A — Asset Bundle (repeatable)

```bash
databricks bundle validate -t <target>            # targets in databricks.yml
databricks bundle deploy   -t <target> \
  --var="warehouse_id=<id>" --var="lakebase_name=<instance>"
databricks bundle run nao  -t <target>
```

### Option B — CLI (first manual pass)

```bash
databricks apps create nao -p <profile>
databricks sync . "/Workspace/Users/$(whoami)/nao_src" -p <profile> \
  --exclude node_modules --exclude .git
databricks apps deploy nao \
  --source-code-path "/Workspace/Users/$(whoami)/nao_src" -p <profile>
# Attach the app resources: lakebase, sql-warehouse, serving-endpoint, and the
# better-auth-secret / pg-password / databricks-token secrets. Data + LLM use the
# long-lived token (so no SP grants are needed there); Lakebase uses the nao_app
# role provisioned by setup.sh.
databricks apps logs nao -p <profile>   # watch [SYSTEM]/[APP] boot lines
```

## Configuration (env)

| Var                                                   | Source                            | Purpose                                          |
| ----------------------------------------------------- | --------------------------------- | ------------------------------------------------ |
| `PGHOST` / `PGPORT`                                   | lakebase resource                 | Lakebase host/port for `DB_URI`                  |
| `NAO_PG_USER` / `NAO_PG_PASSWORD` / `NAO_PG_DATABASE` | app.yaml + `pg-password` secret   | stable native role / password / dedicated DB     |
| `DB_SSL=true`                                         | app.yaml                          | Lakebase requires TLS                            |
| `DATABRICKS_WAREHOUSE_ID`                             | sql-warehouse resource            | → `http_path` for the data connection            |
| `DATABRICKS_TOKEN`                                    | `databricks-token` secret         | long-lived token for warehouse data + LLM apiKey |
| `DATABRICKS_HOST`                                     | platform                          | host → bare hostname + LLM serving base URL      |
| `NAO_DATABRICKS_CATALOG` / `_SCHEMA` / `_TEMP_SCHEMA` | app.yaml                          | analytics catalog/schema + writable temp schema  |
| `NAO_SSO_PASSTHROUGH=true`                            | app.yaml                          | no separate login (trust `X-Forwarded-Email`)    |
| `BETTER_AUTH_SECRET`                                  | better-auth-secret secret         | stable sessions / JWKS                           |
| `BETTER_AUTH_URL`                                     | derived from `DATABRICKS_APP_URL` | auth callbacks                                   |

## Known limitations

- **Chromium / KVM absent.** Chart-image export (puppeteer/Chromium) and Boxlite
  sandboxing (`/dev/kvm`) don't run on Apps. The core NL→SQL→in-browser-chart
  path is unaffected.
- **Auth layering.** Databricks Apps OAuth gates the app; nao's Better Auth sits
  behind it (v1 runs single-tenant). Per-user identity / OBO is a later step.
- **Build egress.** The Apps build downloads native prebuilds (better-sqlite3,
  duckdb, resvg, ripgrep, bun). The workspace must allow build-time egress.
