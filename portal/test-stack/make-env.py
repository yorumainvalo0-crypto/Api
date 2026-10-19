#!/usr/bin/env python3
"""Build test.env for the local test stack from the production env template.

Secrets are generated fresh on every run; the file is git-ignored.
"""
import pathlib
import re
import secrets

here = pathlib.Path(__file__).parent
src = (here / "../deploy/env.production.example").read_text()

values = {
    "LIBRECHAT_HOST_PORT": "3080",
    "PORTAL_HOST_PORT": "3090",
    "DOMAIN_CLIENT": "http://localhost:3080",
    "DOMAIN_SERVER": "http://localhost:3080",
    "ANTHROPIC_API_KEY": "sk-ant-test",
    "OPENROUTER_KEY": "sk-or-test",
    "LIBRECHAT_CODE_API_KEY": "test",
    "OPENID_CLIENT_SECRET": "test-client-secret",
    "OPENID_SESSION_SECRET": secrets.token_hex(32),
    "PORTAL_MCP_TOKEN": "test-mcp-token",
    "CREDS_KEY": secrets.token_hex(32),
    "CREDS_IV": secrets.token_hex(16),
    "JWT_SECRET": secrets.token_hex(32),
    "JWT_REFRESH_SECRET": secrets.token_hex(32),
    "MEILI_MASTER_KEY": secrets.token_hex(16),
    "ADMIN_PANEL_SESSION_SECRET": secrets.token_hex(32),
    "UID": "0",
    "GID": "0",
}
# Login mode: "password" until the gateway exists, "oidc" afterwards
mode = (here / "login-mode").read_text().strip() if (here / "login-mode").exists() else "password"
if mode == "password":
    values.update(
        {
            "ALLOW_EMAIL_LOGIN": "true",
            "ALLOW_SOCIAL_LOGIN": "false",
            "OPENID_AUTO_REDIRECT": "false",
            "OPENID_ISSUER": "",
            "OPENID_CLIENT_ID": "",
        }
    )

lines = []
for line in src.splitlines():
    m = re.match(r"^([A-Z_]+)=(.*)$", line)
    if m and m.group(1) in values:
        line = f"{m.group(1)}={values[m.group(1)]}"
    lines.append(line)
lines += [
    "",
    "# --- test stack only ---",
    "ANTHROPIC_REVERSE_PROXY=http://mocks:8080",
    "SEARCH=false",
    # Tests log in many times from one IP
    "LOGIN_MAX=1000",
    "REGISTER_MAX=1000",
]
(here / "test.env").write_text("\n".join(lines) + "\n")
print(f"wrote test.env (login mode: {mode})")
