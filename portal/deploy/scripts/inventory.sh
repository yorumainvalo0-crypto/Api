#!/usr/bin/env bash
# Read-only server inventory before replacing the old portal (milestone M0).
# Run on the server: sudo bash inventory.sh > inventory.txt   (changes nothing)
set -uo pipefail

DOMAIN="${DOMAIN:-ai.dev.a-b-cloud.de}"

section() { printf '\n===== %s =====\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

section "System"
uname -a
[ -r /etc/os-release ] && grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
echo "CPUs: $(nproc)"
free -h
df -h / /var/lib/docker 2>/dev/null

section "Listening TCP ports"
if have ss; then ss -tlnp; else netstat -tlnp 2>/dev/null; fi

section "nginx"
if have nginx; then
  nginx -v 2>&1
  echo "--- sites for $DOMAIN"
  grep -Rl "$DOMAIN" /etc/nginx/ 2>/dev/null
  echo "--- proxy_pass / root / ssl lines"
  grep -RnE "server_name|proxy_pass|root |ssl_certificate" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null
else
  echo "nginx not installed"
fi

section "TLS certificates"
ls -l /etc/letsencrypt/live/ 2>/dev/null || echo "no /etc/letsencrypt/live"

section "Docker"
if have docker; then
  docker version --format 'Docker {{.Server.Version}}' 2>/dev/null
  docker compose version 2>/dev/null
  docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
  echo "--- compose projects"
  docker compose ls 2>/dev/null
else
  echo "docker not installed"
fi

section "Process managers / services"
have pm2 && pm2 list 2>/dev/null
systemctl list-units --type=service --state=running --no-pager 2>/dev/null \
  | grep -iE 'node|pm2|portal|ai|docker|nginx|mongo|postgres|redis' || true

section "Firewall"
have ufw && ufw status verbose 2>/dev/null
iptables -S INPUT 2>/dev/null | head -20

section "Old portal health"
curl -sS -m 10 -o /dev/null -w "https://$DOMAIN/ -> %{http_code}\n" "https://$DOMAIN/" || true
curl -sS -m 10 "https://$DOMAIN/api/health" || true
echo

section "Done"
echo "Send this output back; it contains no secrets (env files are not read)."
