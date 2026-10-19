#!/usr/bin/env bash
# Start the local test stack from a clean state.
set -euo pipefail
cd "$(dirname "$0")"

docker compose down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf data
# LibreChat runs as uid 1000 inside the container
mkdir -p data/uploads data/images data/logs data/mongo
chmod -R 777 data/uploads data/images data/logs
python3 make-env.py
docker compose up -d

for _ in $(seq 1 90); do
  if curl -fs -o /dev/null http://127.0.0.1:3080/health; then
    echo "LibreChat is up"
    exit 0
  fi
  sleep 2
done
echo "LibreChat did not become healthy" >&2
docker compose logs --tail 50 api >&2
exit 1
