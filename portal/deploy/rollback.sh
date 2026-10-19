#!/usr/bin/env bash
# Switches back to the old portal: stops this portal and starts the old one that ./start.sh stopped.
# Data of both stays; ./start.sh switches over again.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .old-portal ] || { echo "Kein altes Portal vermerkt (.old-portal fehlt)." >&2; exit 1; }
old=$(cat .old-portal)
docker compose stop
docker ps -aq --filter "label=com.docker.compose.project=$old" | xargs -r docker start >/dev/null
echo "Altes Portal (\"$old\") läuft wieder, das neue ist angehalten."
