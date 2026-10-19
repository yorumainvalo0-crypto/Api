#!/usr/bin/env bash
# Restores a backup made by backup.sh.
# Usage: restore.sh <STAMP> [--yes]      e.g. restore.sh 20261019-033000
# Stop LibreChat and the gateway first (docker compose stop api portal-gateway).
set -euo pipefail

STAMP="${1:?usage: restore.sh <STAMP> [--yes]}"
LIBRECHAT_DIR="${LIBRECHAT_DIR:-/opt/LibreChat}"
PORTAL_DATA_DIR="${PORTAL_DATA_DIR:-/opt/portal-data}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/portal}"
MONGO_CONTAINER="${MONGO_CONTAINER:-chat-mongodb}"
RESTORE_CONFIG="${RESTORE_CONFIG:-false}"

cd "$BACKUP_DIR"
sha256sum -c "SHA256SUMS-$STAMP"

if [ "${2:-}" != "--yes" ]; then
  read -r -p "Replace the databases LibreChat + portal and the files with backup $STAMP? [yes/no] " answer
  [ "$answer" = "yes" ] || { echo "aborted"; exit 1; }
fi

for db in LibreChat portal; do
  docker exec -i "$MONGO_CONTAINER" mongorestore --archive --gzip --drop --quiet \
    --nsInclude "$db.*" < "mongo-$db-$STAMP.archive.gz"
done

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
tar -xzf "files-$STAMP.tar.gz" -C "$staging"
for item in uploads images skill; do
  if [ -e "$staging/librechat/$item" ]; then
    rm -rf "${LIBRECHAT_DIR:?}/$item"
    cp -a "$staging/librechat/$item" "$LIBRECHAT_DIR/$item"
  fi
done
# Configuration only on request: it holds the secrets of the backed-up installation
if [ "$RESTORE_CONFIG" = "true" ]; then
  for item in .env portal-gateway.env librechat.yaml docker-compose.override.yml portal-nginx; do
    [ -e "$staging/librechat/$item" ] && cp -a "$staging/librechat/$item" "$LIBRECHAT_DIR/$item"
  done
fi
if [ -d "$staging/media" ]; then
  mkdir -p "$PORTAL_DATA_DIR/media"
  cp -a "$staging/media/." "$PORTAL_DATA_DIR/media/"
fi

echo "$(date -Is) restore ok: $STAMP – now start the services again (docker compose up -d)"
