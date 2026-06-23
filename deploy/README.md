# Deployment targets

nao ships a generic Docker image (see `/Dockerfile`, `/docker-compose.yml`) for
self-hosting. This `deploy/` directory holds **additional, pluggable deployment
targets** that adapt nao to specific platforms without changing core app code.

## Convention

- One subdirectory per target: `deploy/<target>/`.
  - `deploy/databricks/` — Databricks Apps + Lakebase (see its README).
  - Future: `deploy/k8s/`, `deploy/aws-ecs/`, … follow the same shape.
- **Config over code.** A target only changes *how* nao's standard env vars get
  populated (`DB_URI`, `SERVER_PORT`/`--port`, `NAO_CONTEXT_SOURCE`, provider
  keys/base URLs). There are no `if (platform)` branches in the app.
- **Composable start.** Each target supplies a small entry script that resolves
  its platform-specific inputs (connection strings, tokens) and then starts the
  same nao processes (FastAPI sidecar + backend on `$PORT`).
- **Thin core patches only.** Any change to nao core (e.g. an OpenAI-compatible
  LLM provider) must be additive and env-driven so it is reusable by every
  target and upstreamable — never platform-named.
- **Root files.** Platforms that require a file at the repo root (e.g. Databricks
  Apps' `app.yaml`/`requirements.txt`) keep a thin root stub that delegates into
  `deploy/<target>/`.

Adding a target = create `deploy/<target>/` with its entry script + docs and,
if needed, a thin root stub. Nothing else in the repo should need to change.
