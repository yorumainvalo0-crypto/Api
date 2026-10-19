#!/usr/bin/env bash
# Installs, updates and starts the A-B Cloud AI Portal in this folder – one command:
#   sudo ./start.sh            (asks for the Anthropic key and the admin login on the first run)
#   sudo ./start.sh --yes      (also switches over from the old portal without asking)
# First run: writes librechat.env / portal-gateway.env / .env with fresh secrets. Every run: builds the
# portal images, starts everything and takes over port 45012 (stops the old portal there if asked).
# Undo the switch-over with ./rollback.sh.
set -euo pipefail
cd "$(dirname "$0")"

ASSUME_YES=false
[ "${1:-}" = "--yes" ] && ASSUME_YES=true
# Extra `docker build` options, e.g. a proxy CA for test environments; empty on the server
read -r -a BUILD_ARGS <<< "${PORTAL_BUILD_ARGS:-}"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }
confirm() {
  $ASSUME_YES && return 0
  local answer
  read -r -p "$1 [ja/nein] " answer
  [ "$answer" = "ja" ]
}

command -v docker >/dev/null || fail "Docker ist nicht installiert."
docker compose version >/dev/null 2>&1 || fail "Docker Compose (Plugin) fehlt."
command -v python3 >/dev/null || fail "python3 fehlt (apt install python3)."
command -v curl >/dev/null || fail "curl fehlt (apt install curl)."

# --- 1. Configuration (first run only) ---
if [ ! -f librechat.env ]; then
  say "Ersteinrichtung"
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then read -r -s -p "Anthropic-API-Key: " ANTHROPIC_API_KEY; echo; fi
  if [ -z "${PORTAL_ADMIN_USERNAME:-}" ]; then read -r -p "Admin-Benutzername (z. B. michael): " PORTAL_ADMIN_USERNAME; fi
  PORTAL_ADMIN_PASSWORD=${PORTAL_ADMIN_PASSWORD:-}
  while [ "${#PORTAL_ADMIN_PASSWORD}" -lt 12 ]; do
    read -r -s -p "Admin-Passwort (mind. 12 Zeichen): " PORTAL_ADMIN_PASSWORD; echo
  done
  export ANTHROPIC_API_KEY PORTAL_ADMIN_USERNAME PORTAL_ADMIN_PASSWORD
  python3 scripts/setup-env.py
fi
[ -f .env ] && [ -f portal-gateway.env ] || fail "librechat.env ist da, aber .env oder portal-gateway.env fehlt."

# --- 2. Data folders (LibreChat and the gateway run as uid 1000 in their containers) ---
mkdir -p data/mongo data/media data/code-work data/code-store uploads images logs
if [ "$(id -u)" = 0 ]; then
  chown 1000:1000 librechat.env
  chown -R 1000:1000 data/media uploads images logs
else
  chmod -R a+rwX data/media uploads images logs
fi

# --- 3. Images ---
say "Baue die Portal-Images (beim ersten Mal 10–20 Minuten)"
docker build "${BUILD_ARGS[@]}" -t portal-sandbox:latest src/code-runner/sandbox
docker build "${BUILD_ARGS[@]}" -t portal-cad-sandbox:latest src/code-runner/cad-sandbox
docker build "${BUILD_ARGS[@]}" -t portal-code-runner:latest src/code-runner
docker build "${BUILD_ARGS[@]}" -t portal-gateway:latest src/gateway

# --- 4. Services (everything except the entry point) ---
say "Starte Datenbank, Chat, Gateway und Code-Runner"
docker compose up -d mongodb api portal-gateway code-runner
for _ in $(seq 1 60); do
  gateway=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q portal-gateway)" 2>/dev/null || true)
  [ "$gateway" = healthy ] && break
  sleep 3
done
[ "${gateway:-}" = healthy ] || { docker compose logs --tail 30 portal-gateway >&2; fail "Gateway startet nicht."; }

# --- 5. Entry point on the old portal's port ---
port=$(sed -n 's/^PORTAL_HTTP_PORT=//p' .env)
project=$(docker compose config --format json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
old=$(docker ps --filter "publish=$port" --format '{{.Label "com.docker.compose.project"}}' | grep -vx "$project" | sort -u | head -1 || true)
if [ -n "$old" ]; then
  say "Port $port gehört noch dem alten Portal (Compose-Projekt \"$old\")"
  confirm "Altes Portal jetzt stoppen und auf das neue umschalten?" || { echo "Nicht umgeschaltet. Das neue Portal läuft ohne Eingang."; exit 0; }
  echo "$old" > .old-portal
  # stop (not down): containers, volumes and data of the old portal stay for ./rollback.sh
  docker ps -q --filter "label=com.docker.compose.project=$old" | xargs -r docker stop >/dev/null
elif ! docker compose ps -q portal-nginx | grep -q . && (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  fail "Port $port ist belegt (kein Docker-Compose-Projekt). Bitte prüfen: ss -ltnp | grep $port"
fi
docker compose up -d portal-nginx

# --- 6. Check ---
for _ in $(seq 1 40); do
  chat=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health" || true)
  portal=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/portal/health" || true)
  [ "$chat" = 200 ] && [ "$portal" = 200 ] && break
  sleep 3
done
[ "$chat" = 200 ] && [ "$portal" = 200 ] || { docker compose logs --tail 30 api portal-nginx >&2; fail "Chat ($chat) oder Portal ($portal) antwortet nicht auf Port $port."; }

domain=$(sed -n 's/^PORTAL_DOMAIN=//p' .env)
say "Fertig – das neue Portal läuft auf 127.0.0.1:$port"
echo "Admin-Login: https://$domain/portal/admin/login"
echo "Chat:        https://$domain/"
[ -f .old-portal ] && echo "Zurück zum alten Portal: ./rollback.sh"
exit 0
