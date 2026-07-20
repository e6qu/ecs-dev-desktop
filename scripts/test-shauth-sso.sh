#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu

unset CDPATH
unset EDD_VALIDATOR_PROBE_PASSWORD SHAUTH_BOOTSTRAP_ADMIN_PASSWORD SHAUTH_BOOTSTRAP_APPS_JSON
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
shauth_root=${SHAUTH_SOURCE_DIR:?SHAUTH_SOURCE_DIR must point to a Shauth checkout}

for command in curl docker jq node openssl pnpm; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "$command is required" >&2
    exit 1
  }
done
[ -f "$shauth_root/compose.yaml" ] || {
  echo "SHAUTH_SOURCE_DIR does not contain compose.yaml" >&2
  exit 1
}
[ -f "$root/third_party/sockerless/simulators/aws/Dockerfile" ] || {
  echo "third_party/sockerless is not initialized; run git submodule update --init --recursive" >&2
  exit 1
}

work_dir=$(mktemp -d)
provider_project=edd-shauth-provider
aws_project=edd-shauth-aws
app_pid=
postgres_password=$(openssl rand -hex 32)
hydra_secret=$(openssl rand -base64 48 | tr -d '\n')
admin_password=$(openssl rand -base64 48 | tr -d '\n')
client_secret=$(openssl rand -hex 32)
auth_secret=$(openssl rand -base64 48 | tr -d '\n')
validator_probe_password=$(openssl rand -hex 48)
application_origin=http://localhost:3211
provider_origin=http://127.0.0.1:8080

provider_compose() {
  env \
    POSTGRES_PASSWORD="$postgres_password" \
    HYDRA_SYSTEM_SECRET="$hydra_secret" \
    HYDRA_DSN="postgres://shauth:${postgres_password}@postgres:5432/hydra?sslmode=disable" \
    HYDRA_PUBLIC_URL="$provider_origin" \
    SHAUTH_PUBLIC_URL="$provider_origin" \
    SHAUTH_DATABASE_URL="postgres://shauth:${postgres_password}@postgres:5432/shauth?sslmode=disable" \
    GITHUB_CLIENT_ID=edd-integration \
    GITHUB_CLIENT_SECRET=edd-integration-secret \
    SHAUTH_BOOTSTRAP_ADMIN_PASSWORD="$admin_password" \
    SHAUTH_BOOTSTRAP_APPS_JSON="$bootstrap_apps" \
    docker compose --project-name "$provider_project" --project-directory "$shauth_root" \
    -f "$shauth_root/compose.yaml" "$@"
}

aws_compose() {
  docker compose --project-name "$aws_project" --project-directory "$root" \
    -f "$root/docker-compose.tier2.yml" "$@"
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$app_pid" ]; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ]; then
    [ -f "$work_dir/app.log" ] && tail -n 120 "$work_dir/app.log" >&2
    provider_compose logs --no-color --tail=120 shauth hydra >&2 || true
    aws_compose logs --no-color --tail=120 sockerless-aws >&2 || true
  fi
  provider_compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  aws_compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work_dir"
  exit "$status"
}
trap cleanup EXIT INT TERM

bootstrap_apps=$(jq -cn \
  --arg secret "$client_secret" \
  --arg origin "$application_origin" '
  [{
    slug:"ecs-dev-desktop",
    name:"ECS Dev Desktop",
    description:"Cloud development workspaces",
    launch_url:($origin + "/"),
    oidc_client_id:"ecs-dev-desktop",
    oidc_client_secret:$secret,
    redirect_uris:[($origin + "/api/auth/callback/shauth")],
    post_logout_redirect_uris:[($origin + "/signed-out")],
    backchannel_logout_uri:($origin + "/api/auth/shauth/backchannel-logout"),
    health_url:($origin + "/api/healthz"),
    monitoring_url:""
  }]')

provider_compose down --volumes --remove-orphans >/dev/null 2>&1 || true
aws_compose down --volumes --remove-orphans >/dev/null 2>&1 || true
provider_compose up --build --detach
aws_compose up --build --detach --wait sockerless-aws

wait_for_url() {
  url=$1
  name=$2
  attempt=0
  while [ "$attempt" -lt 180 ]; do
    if curl --fail --silent "$url" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "$name did not become ready at $url" >&2
  return 1
}

wait_for_url "$provider_origin/healthz" Shauth
wait_for_url http://localhost:4444/health/ready "Ory Hydra"

# Ory Hydra runs in Docker while the browser and EDD use public loopback
# coordinates. Only the server-to-server back-channel delivery coordinate is
# rewritten to Docker's host gateway; every browser-facing coordinate stays the
# exact registered OpenID Connect URL.
registration=$(curl --fail --silent --show-error http://localhost:4445/admin/clients/ecs-dev-desktop)
registration=$(printf '%s' "$registration" | jq \
  '.backchannel_logout_uri = "http://host.docker.internal:3211/api/auth/shauth/backchannel-logout"')
curl --fail --silent --show-error --request PUT --header 'Content-Type: application/json' \
  --data "$registration" http://localhost:4445/admin/clients/ecs-dev-desktop >/dev/null

export AUTH_URL=$application_origin
export AUTH_SECRET="$auth_secret"
export AUTH_SHAUTH_ISSUER=$provider_origin
export AUTH_SHAUTH_ID=ecs-dev-desktop
export AUTH_SHAUTH_SECRET="$client_secret"
export AUTH_SHAUTH_POST_LOGOUT_URL="$application_origin/signed-out"
export AWS_REGION=us-east-1
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export DYNAMODB_ENDPOINT=http://127.0.0.1:4566
export DYNAMODB_TABLE=ecs-dev-desktop-shauth-sso
export EDD_APP_NAME=edd-shauth-sso
export EDD_GOLDEN=omnibus
export EDD_IMAGE_SOURCE_REPO=e6qu/ecs-dev-desktop
export EDD_IMAGE_SOURCE_BRANCH=main
export EDD_IMAGE_SOURCE_WEBHOOK_SECRET=edd-shauth-sso-webhook-secret
export EDD_SHAUTH_ENV_FILE="$work_dir/provider.env"
EDD_BUILD_SHA=$(git -C "$root" rev-parse --short=12 HEAD)
EDD_BUILD_TIME=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
export EDD_BUILD_SHA EDD_BUILD_TIME

cd "$root"
pnpm --filter web exec tsx scripts/setup-shauth-sso.ts
# shellcheck source=/dev/null
. "$EDD_SHAUTH_ENV_FILE"
pnpm --filter web build
(cd "$root/apps/web" && exec env PORT=3211 NODE_ENV=production node --import tsx server.ts) >"$work_dir/app.log" 2>&1 &
app_pid=$!
wait_for_url "$application_origin/api/healthz" "ECS Dev Desktop"
curl --fail --silent --show-error "$application_origin/api/healthz" | jq --exit-status \
  --arg sha "$EDD_BUILD_SHA" --arg time "$EDD_BUILD_TIME" \
  '.status == "ok" and .service == "web" and .deploy.sha == $sha and .deploy.time == $time' \
  >/dev/null

EDD_VALIDATOR_PROBE_PASSWORD=$validator_probe_password \
  SHAUTH_BOOTSTRAP_ADMIN_PASSWORD=$admin_password \
  pnpm --filter web exec node scripts/shauth-sso-browser.mjs
