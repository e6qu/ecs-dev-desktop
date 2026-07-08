#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Skeptical post-deploy app smoke check. This validates the public application
# surface, not just that ECS accepted a service update.
#
#   scripts/check-deployed-app.sh <base-url> [expected-sha]

set -eu
unset CDPATH

base_url="${1:?usage: check-deployed-app.sh <base-url> [expected-sha]}"
expected_sha="${2:-}"

for c in curl jq; do
  command -v "$c" >/dev/null 2>&1 || {
    echo "edd: '$c' not found on PATH" >&2
    exit 1
  }
done

base_url="${base_url%/}"

health_json=$(curl -fsS "${base_url}/api/healthz")
health_status=$(printf '%s' "$health_json" | jq -r '.status')
health_service=$(printf '%s' "$health_json" | jq -r '.service')
health_sha=$(printf '%s' "$health_json" | jq -r '.deploy.sha')

if [ "$health_status" != "ok" ] || [ "$health_service" != "web" ]; then
  echo "edd: /api/healthz returned unexpected payload: $health_json" >&2
  exit 1
fi

if [ -n "$expected_sha" ] && [ "$health_sha" != "$expected_sha" ]; then
  echo "edd: /api/healthz reports deploy sha '$health_sha', expected '$expected_sha'" >&2
  exit 1
fi

ready_json=$(curl -fsS "${base_url}/api/readyz")
ready_status=$(printf '%s' "$ready_json" | jq -r '.status')
if [ "$ready_status" != "ready" ]; then
  echo "edd: /api/readyz returned unexpected payload: $ready_json" >&2
  exit 1
fi

workspaces_html=$(curl -fsS "${base_url}/workspaces")
if ! printf '%s' "$workspaces_html" | grep -q "Not signed in"; then
  echo "edd: /workspaces did not render the unauthenticated application page" >&2
  exit 1
fi
if printf '%s' "$workspaces_html" | grep -q "This page couldn"; then
  echo "edd: /workspaces rendered a Next.js error boundary" >&2
  exit 1
fi

printf 'edd: app smoke ok (%s, sha=%s)\n' "$base_url" "$health_sha"
