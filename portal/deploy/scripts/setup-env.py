#!/usr/bin/env python3
"""Creates LibreChat's .env and portal-gateway.env with fresh, matching secrets.

Usage (on the server, in /opt/LibreChat):
  ANTHROPIC_API_KEY=sk-ant-... OPENROUTER_API_KEY=sk-or-... \\
  PORTAL_ADMIN_USERNAME=michael PORTAL_ADMIN_PASSWORD='…' \\
  python3 /opt/portal/portal/deploy/scripts/setup-env.py [--target /opt/LibreChat] [--force]

LibreChat's own .env.example (in the target directory) is the base; the portal's values from
env.production.example are applied on top. Existing files are never overwritten without --force.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import secrets
import sys

HERE = pathlib.Path(__file__).resolve().parent
DEPLOY = HERE.parent
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
    parser.add_argument("--target", default="/opt/LibreChat", help="LibreChat checkout")
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

    target = pathlib.Path(args.target)
    env_path, gateway_path = target / ".env", target / "portal-gateway.env"
    for path in (env_path, gateway_path):
        if path.exists() and not args.force:
            print(f"{path} exists; use --force to overwrite", file=sys.stderr)
            return 1
    base = target / ".env.example"
    if not base.exists():
        print(f"{base} not found – run this in a LibreChat checkout", file=sys.stderr)
        return 1

    url = f"https://{args.domain}"
    oidc_secret = secrets.token_hex(32)
    mcp_token = secrets.token_hex(32)
    portal_values = {
        key: value
        for key, value in (
            re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line).groups()  # type: ignore[union-attr]
            for line in (DEPLOY / "env.production.example").read_text().splitlines()
            if re.match(r"^[A-Z][A-Z0-9_]*=", line)
        )
    }
    portal_values.update(
        {
            # Port the server's nginx forwards to (the old portal's port)
            "PORTAL_HTTP_PORT": os.environ.get("PORTAL_HTTP_PORT", "45012"),
            "PORTAL_DOMAIN": args.domain,
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
            "UID": str(os.getuid()),
            "GID": str(os.getgid()),
        }
    )
    env_text = apply(base.read_text(), portal_values)

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
    gateway_text = apply((DEPLOY / "portal-gateway.env.example").read_text(), gateway_values)

    left = [k for k in re.findall(r"^([A-Z0-9_]+)=.*REPLACE_ME", env_text + gateway_text, re.M)]
    for path, text in ((env_path, env_text), (gateway_path, gateway_text)):
        path.write_text(text)
        path.chmod(0o600)
        print(f"wrote {path}")
    if left:
        print(f"still to fill in by hand: {', '.join(sorted(set(left)))}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
