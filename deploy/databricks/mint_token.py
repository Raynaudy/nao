#!/usr/bin/env python3
"""Print a short-lived Databricks OAuth bearer token for the app service principal.

On Databricks Apps the runtime injects DATABRICKS_HOST + DATABRICKS_CLIENT_ID +
DATABRICKS_CLIENT_SECRET. The SDK's Config picks these up automatically and the
authenticate() header carries the bearer token, which nao's connector uses as
`access_token` for the SQL warehouse.

The token is valid ~1h; start.sh mints it at boot. For long-running sessions,
prefer patching nao's connector to use a credentials provider (see README).
"""

import sys

from databricks.sdk.core import Config


def main() -> int:
    cfg = Config()  # auto-detects host + SP client id/secret from the env
    headers = cfg.authenticate()  # {'Authorization': 'Bearer <token>'}
    auth = headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        print("no bearer token", file=sys.stderr)
        return 1
    print(auth[len("Bearer ") :], end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
