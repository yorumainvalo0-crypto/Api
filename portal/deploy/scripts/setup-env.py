#!/usr/bin/env python3
"""Creates librechat.env, portal-gateway.env and .env (compose) with fresh, matching secrets.

Called by ./start.sh on the first start; by hand:
  ANTHROPIC_API_KEY=sk-ant-... PORTAL_ADMIN_USERNAME=michael PORTAL_ADMIN_PASSWORD='…' \\
  python3 scripts/setup-env.py [--target DIR] [--domain ai.dev.a-b-cloud.de] [--force]

The templates env.production.example and portal-gateway.env.example next to docker-compose.yml are
the base. Existing files are never overwritten without --force.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import secrets
import sys

HERE = pathlib.Path(__file__).resolve().parent
PORTAL_DIR = HERE.parent
REQUIRED = ["ANTHROPIC_API_KEY", "PORTAL_ADMIN_USERNAME", "PORTAL_ADMIN_PASSWORD"]


def apply(template: str, values: dict[str, str]) -> str:
    """Sets KEY=value for every key in values; keys missing in the template are appended."""
    seen: set[str] = set()
    lines = []
    for line in template.splitlines():
        match = re.match(r"^#?\s*([A-Z][A-Z0-9_]*)=", line)
        if match and match.group(1) in values:
            key = match.group(1)
            if key in seen:
                continue
            line = f"{key}={values[key]}"
            seen.add(key)
        lines.append(line)
    missing = [k for k in values if k not in seen]
    if missing:
        lines += ["", "# --- A-B Cloud AI Portal ---", *(f"{k}={values[k]}" for k in missing)]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", default=str(PORTAL_DIR), help="portal folder (with docker-compose.yml)")
    parser.add_argument("--domain", default=os.environ.get("PORTAL_DOMAIN", "ai.dev.a-b-cloud.de"))
    parser.add_argument("--force", action="store_true", help="overwrite existing files")
    args = parser.parse_args()

    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if missing:
        print(f"missing environment variables: {', '.join(missing)}", file=sys.stderr)
        return 2
    if len(os.environ["PORTAL_ADMIN_PASSWORD"]) < 12:
        print("PORTAL_ADMIN_PASSWORD must have at least 12 characters", file=sys.stderr)
        return 2

    target = pathlib.Path(args.target).resolve()
    paths = {name: target / name for name in ("librechat.env", "portal-gateway.env", ".env")}
    for path in paths.values():
        if path.exists() and not args.force:
            print(f"{path} exists; use --force to overwrite", file=sys.stderr)
            return 1

    url = f"https://{args.domain}"
    oidc_secret = secrets.token_hex(32)
    mcp_token = secrets.token_hex(32)
    port = os.environ.get("PORTAL_HTTP_PORT", "45012")
    librechat_values = {
        "DOMAIN_CLIENT": url,
        "DOMAIN_SERVER": url,
        "ANTHROPIC_API_KEY": os.environ["ANTHROPIC_API_KEY"],
        "OPENROUTER_KEY": os.environ.get("OPENROUTER_API_KEY", ""),
        "OPENID_ISSUER": f"{url}/portal/oidc",
        "OPENID_CLIENT_SECRET": oidc_secret,
        "OPENID_SESSION_SECRET": secrets.token_hex(32),
        "PORTAL_MCP_TOKEN": mcp_token,
        "CREDS_KEY": secrets.token_hex(32),
        "CREDS_IV": secrets.token_hex(16),
        "JWT_SECRET": secrets.token_hex(32),
        "JWT_REFRESH_SECRET": secrets.token_hex(32),
        "MEILI_MASTER_KEY": secrets.token_hex(16),
        "ADMIN_PANEL_SESSION_SECRET": secrets.token_hex(32),
        "PORTAL_HTTP_PORT": port,
        "PORTAL_DOMAIN": args.domain,
    }
    gateway_values = {
        "PUBLIC_URL": url,
        "PORTAL_SECRET": secrets.token_hex(32),
        "OIDC_CLIENT_SECRET": oidc_secret,
        "PORTAL_MCP_TOKEN": mcp_token,
        "USER_EMAIL_DOMAIN": f"users.{args.domain}",
        "PORTAL_ADMIN_USERNAME": os.environ["PORTAL_ADMIN_USERNAME"],
        "PORTAL_ADMIN_PASSWORD": os.environ["PORTAL_ADMIN_PASSWORD"],
        "OPENROUTER_API_KEY": os.environ.get("OPENROUTER_API_KEY", ""),
    }
    texts = {
        "librechat.env": apply((PORTAL_DIR / "env.production.example").read_text(), librechat_values),
        "portal-gateway.env": apply((PORTAL_DIR / "portal-gateway.env.example").read_text(), gateway_values),
        # Read by docker compose itself for ${…} in docker-compose.yml
        ".env": (
            "# docker compose variables (written by scripts/setup-env.py)\n"
            f"CODE_WORK_DIR={target / 'data' / 'code-work'}\n"
            f"PORTAL_HTTP_PORT={port}\n"
            f"PORTAL_DOMAIN={args.domain}\n"
        ),
    }

    left = re.findall(r"^([A-Z0-9_]+)=.*REPLACE_ME", "".join(texts.values()), re.M)
    for name, text in texts.items():
        paths[name].write_text(text)
        paths[name].chmod(0o600)
        print(f"wrote {paths[name]}")
    if left:
        print(f"still to fill in by hand: {', '.join(sorted(set(left)))}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
