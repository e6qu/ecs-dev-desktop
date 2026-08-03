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
# Which signed-out shell renders depends on the deployment's identity provider.
# With Shauth the page enters the provider and offers the app-owned Shauth link;
# without it the app offers its own sign-in. Asserting only the second string
# passed no Shauth deployment, which is every deployment this repository has.
if ! printf '%s' "$workspaces_html" | grep -qE 'Not signed in|/login/shauth'; then
  echo "edd: /workspaces did not render the unauthenticated application page" >&2
  exit 1
fi
if printf '%s' "$workspaces_html" | grep -q "This page couldn"; then
  echo "edd: /workspaces rendered a Next.js error boundary" >&2
  exit 1
fi

# Every application session begins with a redirect the browser must receive
# itself: Auth.js answers the OpenID Connect callback with a 3xx that carries
# the session cookie, and the logout bridge answers with a 3xx back to Shauth.
# An edge that follows those redirects server-side instead of returning them
# serves the redirect TARGET as a 200 and drops the Set-Cookie along the way, so
# sign-in can never complete while every page still looks healthy (e6qu/infra
# #257). Probe both redirects directly; only Shauth deployments have them.
if curl -fsS "${base_url}/api/auth/providers" | jq -e 'has("shauth")' >/dev/null 2>&1; then
  callback_status=$(curl -sS -o /dev/null -w '%{http_code}' \
    "${base_url}/api/auth/callback/shauth?code=deployed-smoke&state=deployed-smoke")
  case "$callback_status" in
    3??) ;;
    *)
      echo "edd: the Shauth callback answered HTTP $callback_status instead of a redirect;" >&2
      echo "edd: the edge in front of this deployment is following redirects itself, which" >&2
      echo "edd: discards the session cookie and makes sign-in impossible" >&2
      exit 1
      ;;
  esac

  logout_bridge_status=$(curl -sS -o /dev/null -w '%{http_code}' \
    "${base_url}/auth/shauth/logout/complete")
  case "$logout_bridge_status" in
    3??) ;;
    *)
      echo "edd: the Shauth logout bridge answered HTTP $logout_bridge_status instead of a" >&2
      echo "edd: redirect back to Shauth, so RP-initiated logout cannot complete" >&2
      exit 1
      ;;
  esac
fi

printf 'edd: app smoke ok (%s, sha=%s)\n' "$base_url" "$health_sha"
