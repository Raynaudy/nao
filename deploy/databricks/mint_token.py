#!/usr/bin/env python3
"""Mint short-lived Databricks tokens for the app service principal.

Default (no args): print a workspace OAuth bearer token, used by nao as the
`access_token` for the SQL warehouse data connection and as the LLM apiKey for
Databricks Model Serving.

--lakebase <instance>: print a Lakebase Postgres OAuth credential, used as the
PGPASSWORD for the metadata DB connection (Lakebase has no static password).

On Databricks Apps the runtime injects DATABRICKS_HOST + DATABRICKS_CLIENT_ID +
DATABRICKS_CLIENT_SECRET; the SDK Config picks these up automatically. Tokens
are short-lived (~1h); start.sh mints them at boot. See README for the
auto-refresh enhancement.
"""

import sys
import uuid


def mint_workspace_token() -> int:
    from databricks.sdk.core import Config

    cfg = Config()
    auth = cfg.authenticate().get("Authorization", "")
    if not auth.startswith("Bearer "):
        print("no bearer token", file=sys.stderr)
        return 1
    print(auth[len("Bearer ") :], end="")
    return 0


def mint_lakebase_credential(instance: str) -> int:
    from databricks.sdk import WorkspaceClient

    w = WorkspaceClient()
    cred = w.database.generate_database_credential(
        request_id=str(uuid.uuid4()), instance_names=[instance]
    )
    if not getattr(cred, "token", None):
        print("no lakebase token", file=sys.stderr)
        return 1
    print(cred.token, end="")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "--lakebase":
        return mint_lakebase_credential(argv[1])
    return mint_workspace_token()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
