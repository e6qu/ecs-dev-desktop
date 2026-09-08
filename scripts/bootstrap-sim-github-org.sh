#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Create the e2e GitHub organization on the running bleephub and install the
# seeded App onto it.
#
# bleephub resolves every seeded installation account when it boots and refuses
# to start on one that does not exist, so the startup seed
# (gen-sim-github-app.sh) can only name the admin user. The organization the
# tests use is therefore created here, after the server is up, through the same
# API a real operator would use:
#
#   POST /api/v3/admin/organizations   (admin token)  — org owned by admin
#   POST /apps/{slug}/installations/new (admin session) — install the App on it
#
# Idempotent: an org that already exists and an App already installed on it are
# both success, so a re-run of the harness is safe.
#
# Portable: POSIX sh, passes shellcheck, runs under bash and zsh on macOS+Linux.
set -eu
unset CDPATH

github_url="${EDD_GITHUB_URL:-http://127.0.0.1:5555}"
admin_login="${EDD_GITHUB_ADMIN_LOGIN:-admin}"
admin_token="${EDD_GITHUB_ADMIN_TOKEN:-edd-e2e-admin-token}"
app_slug="${EDD_GITHUB_APP_SLUG:-edd-app-e2e}"
org="${EDD_GITHUB_TEST_ORG:-edd-app-org}"

api() {
  method=$1
  path=$2
  shift 2
  curl --silent --show-error --output "$body_file" --write-out '%{http_code}' \
    --request "$method" "${github_url}${path}" "$@"
}

fail() {
  echo "bootstrap-sim-github-org: $1" >&2
  [ -s "$body_file" ] && head -c 400 "$body_file" >&2 && echo >&2
  exit 1
}

body_file=$(mktemp)
trap 'rm -f "$body_file" "$cookie_file"' EXIT
cookie_file=$(mktemp)

# The server has to be serving before any of this means anything. The compose
# healthcheck already gates on it; this is the same wait for a direct run.
i=0
while [ "$i" -lt 60 ]; do
  if [ "$(api GET /api/v3/rate_limit)" = "200" ]; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
[ "$i" -lt 60 ] || fail "bleephub at ${github_url} did not answer within 60s"

status=$(api POST /api/v3/admin/organizations \
  --header "Authorization: token ${admin_token}" \
  --header 'Content-Type: application/json' \
  --data "{\"login\":\"${org}\",\"admin\":\"${admin_login}\",\"profile_name\":\"${org}\"}")
case "$status" in
  201 | 422) ;; # created, or already there from an earlier run
  *) fail "creating organization ${org} returned ${status}" ;;
esac

# The install route is the browser one: it acts as the signed-in user, who must
# be able to install on the target. The admin owns the org created above.
login_status=$(api POST /login \
  --cookie-jar "$cookie_file" \
  --data-urlencode "login=${admin_login}" \
  --data-urlencode "password=${admin_token}")
[ "$login_status" = "200" ] || fail "signing in as ${admin_login} returned ${login_status}"

status=$(api "POST" "/apps/${app_slug}/installations/new" \
  --cookie "$cookie_file" \
  --data-urlencode "target_login=${org}")
case "$status" in
  200 | 201 | 422) ;; # installed, or already installed
  *) fail "installing ${app_slug} on ${org} returned ${status}" ;;
esac

echo "bootstrap-sim-github-org: ${app_slug} installed on ${org}"
