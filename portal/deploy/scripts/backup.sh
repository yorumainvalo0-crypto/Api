#!/usr/bin/env bash
# Daily portal backup: both MongoDB databases (LibreChat + portal), uploaded and generated
# files, and the configuration. Restore with restore.sh.
# Cron example: 30 3 * * * /opt/portal/portal/deploy/scripts/backup.sh >> /var/log/portal-backup.log 2>&1
set -euo pipefail

LIBRECHAT_DIR="${LIBRECHAT_DIR:-/opt/LibreChat}"
PORTAL_DATA_DIR="${PORTAL_DATA_DIR:-/opt/portal-data}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/portal}"
MONGO_CONTAINER="${MONGO_CONTAINER:-chat-mongodb}"
KEEP_DAYS="${KEEP_DAYS:-14}"
# Optional off-site copy, e.g. "u123456@u123456.your-storagebox.de:portal-backups" (SSH port 23)
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
BACKUP_REMOTE_PORT="${BACKUP_REMOTE_PORT:-23}"
STAMP="${STAMP:-$(date +%Y%m%d-%H%M%S)}"

umask 077
mkdir -p "$BACKUP_DIR"

# Accounts, chats, balances, transactions (LibreChat) and logins, invites, budgets, CAD models (portal)
for db in LibreChat portal; do
  docker exec "$MONGO_CONTAINER" mongodump --db "$db" --archive --gzip --quiet \
    > "$BACKUP_DIR/mongo-$db-$STAMP.archive.gz"
done

# Files and configuration; .env files hold secrets, so the backup directory stays private
files=()
for item in uploads images .env portal-gateway.env librechat.yaml docker-compose.override.yml skill; do
  if [ -e "$LIBRECHAT_DIR/$item" ]; then
    files+=("librechat/$item")
  else
    echo "warning: $LIBRECHAT_DIR/$item missing, skipped" >&2
  fi
done
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
ln -s "$LIBRECHAT_DIR" "$staging/librechat"
if [ -d "$PORTAL_DATA_DIR/media" ]; then
  ln -s "$PORTAL_DATA_DIR/media" "$staging/media"
  files+=("media/")
fi
tar -czhf "$BACKUP_DIR/files-$STAMP.tar.gz" -C "$staging" "${files[@]}"

# Integrity check of what was just written
for archive in "$BACKUP_DIR"/*-"$STAMP".*; do
  gzip -t "$archive"
done
sha256sum "$BACKUP_DIR"/*-"$STAMP".* > "$BACKUP_DIR/SHA256SUMS-$STAMP"

find "$BACKUP_DIR" -type f -mtime +"$KEEP_DAYS" -delete

if [ -n "$BACKUP_REMOTE" ]; then
  rsync -a -e "ssh -p $BACKUP_REMOTE_PORT" "$BACKUP_DIR"/*-"$STAMP"* "$BACKUP_REMOTE/"
fi

echo "$(date -Is) backup ok: $STAMP ($(du -ch "$BACKUP_DIR"/*-"$STAMP"* | tail -1 | cut -f1))"
