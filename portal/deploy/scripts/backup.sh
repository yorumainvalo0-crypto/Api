#!/usr/bin/env bash
# Daily LibreChat backup: MongoDB dump + uploads + config.
# Cron example: 30 3 * * * /opt/LibreChat/backup.sh >> /var/log/librechat-backup.log 2>&1
set -euo pipefail

LIBRECHAT_DIR="${LIBRECHAT_DIR:-/opt/LibreChat}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/librechat}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

# Accounts, chats and balances
docker exec chat-mongodb mongodump --db LibreChat --archive --gzip \
  > "$BACKUP_DIR/mongo-$STAMP.archive.gz"

# Uploaded files, images and config (.env holds secrets: keep the backup dir private)
tar -czf "$BACKUP_DIR/files-$STAMP.tar.gz" -C "$LIBRECHAT_DIR" \
  uploads images .env librechat.yaml docker-compose.override.yml

chmod 600 "$BACKUP_DIR"/*-"$STAMP".*
find "$BACKUP_DIR" -type f -mtime +"$KEEP_DAYS" -delete

echo "$(date -Is) backup ok: $STAMP"
