#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
unset CDPATH

repo=${GITHUB_REPO:-e6qu/ecs-dev-desktop}
app_url=${EDD_APP_URL:-}
issuer=${EDD_SHAUTH_ISSUER:-}
username=${EDD_SHAUTH_SMOKE_USERNAME:-}
password=${EDD_SHAUTH_SMOKE_PASSWORD:-}

missing() {
  name=$1
  value=$2
  if [ -z "$value" ]; then
    echo "edd: $name is required" >&2
    return 1
  fi
}

missing EDD_APP_URL "$app_url" || exit 1
missing EDD_SHAUTH_ISSUER "$issuer" || exit 1
missing EDD_SHAUTH_SMOKE_USERNAME "$username" || exit 1
missing EDD_SHAUTH_SMOKE_PASSWORD "$password" || exit 1

case "$app_url" in https://*) ;; *)
  echo "edd: EDD_APP_URL must use HTTPS" >&2
  exit 1
  ;;
esac
case "$issuer" in https://*) ;; *)
  echo "edd: EDD_SHAUTH_ISSUER must use HTTPS" >&2
  exit 1
  ;;
esac
case "$username" in smoke-*) ;; *)
  echo "edd: smoke username must start with smoke-" >&2
  exit 1
  ;;
esac

gh auth status >/dev/null
gh variable set EDD_APP_URL --repo "$repo" --body "$app_url"
gh variable set EDD_SHAUTH_ISSUER --repo "$repo" --body "$issuer"
gh variable set EDD_SHAUTH_SMOKE_USERNAME --repo "$repo" --body "$username"
printf '%s' "$password" | gh secret set EDD_SHAUTH_SMOKE_PASSWORD --repo "$repo"

echo "edd: configured Shauth-only post-deployment smoke coordinates for $repo"
