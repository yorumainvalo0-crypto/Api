#!/usr/bin/env bash
# Start the local test stack from a clean state.
set -euo pipefail
cd "$(dirname "$0")"

# Compose reads .env for variable interpolation (also for `docker compose exec` in the tests)
printf 'CODE_WORK_DIR=%s\n' "$PWD/data/code-work" > .env
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf data
# LibreChat runs as uid 1000 inside the container
mkdir -p data/uploads data/images data/logs data/mongo data/certs data/code-work data/code-store
chmod -R 777 data/uploads data/images data/logs

# Test CA + certificate for portal.test (LibreChat only talks OIDC over HTTPS)
openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj "/CN=Portal Test CA" \
  -keyout data/certs/ca.key -out data/certs/ca.pem 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=portal.test" \
  -keyout data/certs/portal.test.key -out data/certs/portal.test.csr 2>/dev/null
printf 'subjectAltName=DNS:portal.test\n' > data/certs/san.ext
openssl x509 -req -in data/certs/portal.test.csr -CA data/certs/ca.pem -CAkey data/certs/ca.key \
  -CAcreateserial -days 3 -extfile data/certs/san.ext -out data/certs/portal.test.pem 2>/dev/null
chmod 644 data/certs/*

python3 make-env.py
docker compose up -d

for _ in $(seq 1 90); do
  if curl --noproxy '*' -fs -o /dev/null --resolve portal.test:8443:127.0.0.1 --cacert data/certs/ca.pem \
    https://portal.test:8443/health \
    && curl --noproxy '*' -fs -o /dev/null --resolve portal.test:8443:127.0.0.1 --cacert data/certs/ca.pem \
    https://portal.test:8443/portal/health; then
    echo "stack is up: https://portal.test:8443"
    exit 0
  fi
  sleep 2
done
echo "stack did not become healthy" >&2
docker compose logs --tail 40 api portal-gateway nginx >&2
exit 1
