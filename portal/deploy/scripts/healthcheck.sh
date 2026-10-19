#!/usr/bin/env bash
# Checks that the portal answers and all containers run; alerts once per incident.
# Cron example: */5 * * * * /opt/ai-portal-neu/scripts/healthcheck.sh >> /var/log/portal-health.log 2>&1
# Optional alert: ALERT_URL=https://ntfy.sh/<your-topic> (any URL accepting a POSTed text message)
set -uo pipefail

DOMAIN="${DOMAIN:-ai.dev.a-b-cloud.de}"
PORTAL_DIR="${PORTAL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ALERT_URL="${ALERT_URL:-}"
STATE_FILE="${STATE_FILE:-/var/tmp/portal-health.state}"
SERVICES="${SERVICES:-portal-nginx api mongodb portal-gateway code-runner}"

problems=()
for path in /health /portal/health; do
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$DOMAIN$path" || true)
  [ "$code" = "200" ] || problems+=("https://$DOMAIN$path -> HTTP $code")
done
for service in $SERVICES; do
  state=$(docker compose --project-directory "$PORTAL_DIR" ps --format '{{.State}}' "$service" 2>/dev/null || true)
  [ "$state" = "running" ] || problems+=("container $service: ${state:-missing}")
done
# The internal tool endpoint must never be reachable from outside
code=$(curl -s -o /dev/null -m 15 -X POST -w '%{http_code}' "https://$DOMAIN/portal/mcp" || true)
[ "$code" = "404" ] || problems+=("/portal/mcp is reachable from outside (HTTP $code)")

previous=$(cat "$STATE_FILE" 2>/dev/null || echo ok)
if [ ${#problems[@]} -eq 0 ]; then
  if [ "$previous" != "ok" ] && [ -n "$ALERT_URL" ]; then
    curl -s -m 10 -d "A-B Cloud AI Portal ist wieder erreichbar." "$ALERT_URL" >/dev/null || true
  fi
  echo ok > "$STATE_FILE"
  exit 0
fi

message="A-B Cloud AI Portal: $(IFS='; '; echo "${problems[*]}")"
echo "$(date -Is) $message"
if [ "$previous" = "ok" ] && [ -n "$ALERT_URL" ]; then
  curl -s -m 10 -d "$message" "$ALERT_URL" >/dev/null || true
fi
echo failing > "$STATE_FILE"
exit 1
