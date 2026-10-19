#!/usr/bin/env bash
# Daily portal backup: both MongoDB databases (LibreChat + portal), uploaded and generated
# files, and the configuration. Restore with restore.sh.
# Cron example: 30 3 * * * $HOME/docker/ai-portal-neu/scripts/backup.sh >> $HOME/portal-backup.log 2>&1
set -euo pipefail

PORTAL_DIR="${PORTAL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
# Without root /var/backups is not writable: keep the backups in the home folder
if [ "$(id -u)" = 0 ]; then BACKUP_DIR="${BACKUP_DIR:-/var/backups/portal}"; else BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/ai-portal}"; fi
KEEP_DAYS="${KEEP_DAYS:-14}"
# Optional off-site copy, e.g. "u123456@u123456.your-storagebox.de:portal-backups" (SSH port 23)
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
BACKUP_REMOTE_PORT="${BACKUP_REMOTE_PORT:-23}"
STAMP="${STAMP:-$(date +%Y%m%d-%H%M%S)}"

umask 077
mkdir -p "$BACKUP_DIR"

# Accounts, chats, balances, transactions (LibreChat) and logins, invites, budgets, CAD models (portal)
for db in LibreChat portal; do
  docker compose --project-directory "$PORTAL_DIR" exec -T mongodb mongodump --db "$db" --archive --gzip --quiet \
    > "$BACKUP_DIR/mongo-$db-$STAMP.archive.gz"
done

# Files and configuration; .env files hold secrets, so the backup directory stays private
files=()
for item in uploads images data/media librechat.env portal-gateway.env .env librechat.yaml docker-compose.yml skill nginx; do
  if [ -e "$PORTAL_DIR/$item" ]; then
    files+=("portal/$item")
  else
    echo "warning: $PORTAL_DIR/$item missing, skipped" >&2
  fi
done
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
ln -s "$PORTAL_DIR" "$staging/portal"
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
