#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Robust local e2e run (`pnpm test:e2e:local`): reap prior state, build the test
# images + sim certs/seeds, bring up the container-mode AWS sim + SSH harnesses,
# then run the e2e suite. HEAVY — builds the ~3 GB golden workspace image and runs
# real task containers; needs a container runtime (Docker/podman). All setup is
# idempotent and reaped first, so a half-finished prior run won't block this one.
# See TESTING.md / docs/running-locally.md.
set -eu
unset CDPATH
here="$(dirname "$0")"

# Podman exposes a Docker-compatible API, but unqualified local image names
# (e.g. `edd-workspace:e2e`) resolve to docker.io. Use a local insecure registry
# on podman machines so the container-mode sim can pull task images by a fully
# qualified name. Real Docker daemons keep the unqualified names.
is_podman=false
if docker version 2>/dev/null | grep -q 'Podman Engine'; then
  is_podman=true
fi

sh "$here/reap-local.sh"

if [ "$is_podman" = true ]; then
  # macOS AirPlay Receiver binds :5000, so use a high port for the local registry.
  registry_port=15000
  docker rm -f edd-e2e-registry >/dev/null 2>&1 || true
  docker run -d --name edd-e2e-registry -p "127.0.0.1:${registry_port}:5000" docker.io/library/registry:2 >/dev/null
  i=0
  while [ "$i" -lt 30 ]; do
    if curl -fsS "http://127.0.0.1:${registry_port}/v2/" >/dev/null 2>&1; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$i" -eq 30 ]; then
    echo "edd: local e2e registry did not come up" >&2
    exit 1
  fi
fi

pnpm build
if [ "$is_podman" = true ]; then
  base_tag="localhost:${registry_port}/edd-base:e2e"
  workspace_tag="localhost:${registry_port}/edd-workspace:e2e"
  reconciler_tag="localhost:${registry_port}/edd-reconciler:e2e"
  proxy_tag="localhost:${registry_port}/edd-ssh-proxy:e2e"
  node_tag="localhost:${registry_port}/edd-workspace-node:e2e"

  podman build -f services/reconciler/Dockerfile -t "$reconciler_tag" .
  podman push --tls-verify=false "$reconciler_tag"
  podman build -f services/ssh-gateway/Dockerfile.proxy -t "$proxy_tag" .
  podman push --tls-verify=false "$proxy_tag"

  bash infra/images/base/build.sh "$base_tag"
  podman push --tls-verify=false "$base_tag"
  podman build --build-arg BASE="$base_tag" -t "$workspace_tag" infra/images/omnibus
  podman push --tls-verify=false "$workspace_tag"
else
  docker build -f services/reconciler/Dockerfile -t edd-reconciler:e2e .
  docker build -f services/ssh-gateway/Dockerfile.proxy -t edd-ssh-proxy:e2e .
  bash infra/images/base/build.sh edd-base:e2e
  docker build --build-arg BASE=edd-base:e2e -t edd-workspace:e2e infra/images/omnibus
fi
sh "$here/gen-sim-tls-cert.sh"
sh "$here/gen-sim-github-app.sh"
docker compose -f docker-compose.e2e.yml up -d --build --wait
# Registered-key SSH e2e are self-contained (each docker-runs its own node + proxy);
# they only need the node image pre-built.
if [ "$is_podman" = true ]; then
  podman build -f services/ssh-gateway/Dockerfile.node -t "$node_tag" .
  podman push --tls-verify=false "$node_tag"
else
  docker build -f services/ssh-gateway/Dockerfile.node -t edd-workspace-node:e2e .
fi

# shellcheck disable=SC1091 # generated at bring-up by gen-sim-github-app.sh
. ./temp/github-app/coords.env
if [ "$is_podman" = true ]; then
  export WORKSPACE_IMAGE="$workspace_tag"
  export RECONCILER_IMAGE="$reconciler_tag"
  export PROXY_IMAGE="$proxy_tag"
  export NODE_IMAGE="$node_tag"
fi
RECONCILER_IMAGE="${RECONCILER_IMAGE:-edd-reconciler:e2e}" \
  PROXY_IMAGE="${PROXY_IMAGE:-edd-ssh-proxy:e2e}" \
  NODE_IMAGE="${NODE_IMAGE:-edd-workspace-node:e2e}" \
  pnpm test:e2e
