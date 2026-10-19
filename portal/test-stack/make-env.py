#!/usr/bin/env python3
"""Build test.env (LibreChat) and gateway.env for the local test stack.

LibreChat's values come from the production template; secrets are generated fresh on every
run. Both files are git-ignored.
"""
import pathlib
import re
import secrets

here = pathlib.Path(__file__).parent
PUBLIC_URL = "https://portal.test:8443"
OIDC_CLIENT_SECRET = secrets.token_hex(16)
MCP_TOKEN = secrets.token_hex(16)

values = {
    "LIBRECHAT_HOST_PORT": "3080",
    "PORTAL_HOST_PORT": "3090",
    "DOMAIN_CLIENT": PUBLIC_URL,
    "DOMAIN_SERVER": PUBLIC_URL,
    "ANTHROPIC_API_KEY": "sk-ant-test",
    "OPENROUTER_KEY": "sk-or-test",
    "OPENID_ISSUER": f"{PUBLIC_URL}/portal/oidc",
    "OPENID_CLIENT_SECRET": OIDC_CLIENT_SECRET,
    "OPENID_SESSION_SECRET": secrets.token_hex(32),
    "PORTAL_MCP_TOKEN": MCP_TOKEN,
    "CREDS_KEY": secrets.token_hex(32),
    "CREDS_IV": secrets.token_hex(16),
    "JWT_SECRET": secrets.token_hex(32),
    "JWT_REFRESH_SECRET": secrets.token_hex(32),
    "MEILI_MASTER_KEY": secrets.token_hex(16),
    "ADMIN_PANEL_SESSION_SECRET": secrets.token_hex(32),
    "UID": "0",
    "GID": "0",
}

src = (here / "../deploy/env.production.example").read_text()
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

gateway = {
    "PUBLIC_URL": PUBLIC_URL,
    "MONGO_URI": "mongodb://mongodb:27017",
    "PORTAL_SECRET": secrets.token_hex(32),
    "OIDC_CLIENT_SECRET": OIDC_CLIENT_SECRET,
    "PORTAL_MCP_TOKEN": MCP_TOKEN,
    "PORTAL_ADMIN_USERNAME": "chef",
    "PORTAL_ADMIN_PASSWORD": "test-admin-password",
    "USER_EMAIL_DOMAIN": "users.portal.test",
    "COOKIE_SECURE": "true",
    "OPENROUTER_API_KEY": "sk-or-test",
    "OPENROUTER_BASE_URL": "http://mocks:8080/api/v1",
    "MEDIA_DIR": "/data/media",
}
(here / "gateway.env").write_text("".join(f"{k}={v}\n" for k, v in gateway.items()))
print("wrote test.env and gateway.env")
