#!/usr/bin/env bash
# Builds the portal images on the server from this repository checkout.
# Usage: portal/deploy/scripts/build-images.sh   (tags :latest)
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"

docker build -t portal-sandbox:latest "$repo/portal/code-runner/sandbox"
docker build -t portal-code-runner:latest "$repo/portal/code-runner"
docker build -t portal-gateway:latest "$repo/portal/gateway"
echo "built portal-sandbox, portal-code-runner, portal-gateway"
