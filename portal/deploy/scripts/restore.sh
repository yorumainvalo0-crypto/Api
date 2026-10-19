#!/usr/bin/env bash
# Restores a backup made by backup.sh.
# Usage: restore.sh <STAMP> [--yes]      e.g. restore.sh 20261019-033000
# Stop the chat and the gateway first (docker compose stop api portal-gateway).
set -euo pipefail

STAMP="${1:?usage: restore.sh <STAMP> [--yes]}"
PORTAL_DIR="${PORTAL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
# Without root /var/backups is not writable: keep the backups in the home folder
if [ "$(id -u)" = 0 ]; then BACKUP_DIR="${BACKUP_DIR:-/var/backups/portal}"; else BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/ai-portal}"; fi
RESTORE_CONFIG="${RESTORE_CONFIG:-false}"

cd "$BACKUP_DIR"
sha256sum -c "SHA256SUMS-$STAMP"

if [ "${2:-}" != "--yes" ]; then
  read -r -p "Replace the databases LibreChat + portal and the files with backup $STAMP? [yes/no] " answer
  [ "$answer" = "yes" ] || { echo "aborted"; exit 1; }
fi

for db in LibreChat portal; do
  docker compose --project-directory "$PORTAL_DIR" exec -T mongodb mongorestore --archive --gzip --drop --quiet \
    --nsInclude "$db.*" < "mongo-$db-$STAMP.archive.gz"
done

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
tar -xzf "files-$STAMP.tar.gz" -C "$staging"
for item in uploads images data/media; do
  if [ -e "$staging/portal/$item" ]; then
    rm -rf "${PORTAL_DIR:?}/$item"
    mkdir -p "$(dirname "$PORTAL_DIR/$item")"
    cp -a "$staging/portal/$item" "$PORTAL_DIR/$item"
  fi
done
# Configuration only on request: it holds the secrets of the backed-up installation
if [ "$RESTORE_CONFIG" = "true" ]; then
  for item in librechat.env portal-gateway.env .env librechat.yaml docker-compose.yml skill nginx; do
    [ -e "$staging/portal/$item" ] && rm -rf "${PORTAL_DIR:?}/$item" && cp -a "$staging/portal/$item" "$PORTAL_DIR/$item"
  done
fi

echo "$(date -Is) restore ok: $STAMP – now start the services again (docker compose up -d)"
