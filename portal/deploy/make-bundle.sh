#!/usr/bin/env bash
# Builds the upload folder for the server: everything in portal/deploy plus the gateway and code
# runner sources under src/. Usage: portal/deploy/make-bundle.sh [OUT.tar.gz]
# On the server: tar xzf ai-portal-neu.tar.gz -C /opt && sudo /opt/ai-portal-neu/start.sh
set -euo pipefail
deploy="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$deploy/../.." && pwd)"
out="$(realpath -m "${1:-$PWD/ai-portal-neu.tar.gz}")"
name=ai-portal-neu

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
# Tracked files only: no node_modules, test data or local env files
git -C "$repo" archive --format=tar --prefix="$name/" HEAD:portal/deploy | tar -x -C "$stage"
mkdir -p "$stage/$name/src"
git -C "$repo" archive --format=tar --prefix=gateway/ HEAD:portal/gateway | tar -x -C "$stage/$name/src"
git -C "$repo" archive --format=tar --prefix=code-runner/ HEAD:portal/code-runner | tar -x -C "$stage/$name/src"
git -C "$repo" show HEAD:docs/GO-LIVE.md > "$stage/$name/GO-LIVE.md"
rm -f "$stage/$name/make-bundle.sh" "$stage/$name/.gitignore"
tar -czf "$out" -C "$stage" "$name"
echo "built $out ($(du -h "$out" | cut -f1))"
