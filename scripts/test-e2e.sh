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

sh "$here/reap-local.sh"
pnpm build
docker build -f services/reconciler/Dockerfile -t edd-reconciler:e2e .
docker build -f services/ssh-gateway/Dockerfile.proxy -t edd-ssh-proxy:e2e .
# Golden image collection: build the shared base, then the omnibus variant FROM it
# (tagged edd-workspace:e2e — the default image the e2e/live suites launch).
docker build -t edd-base:e2e infra/images/base
docker build --build-arg BASE=edd-base:e2e -t edd-workspace:e2e infra/images/omnibus
sh "$here/gen-sim-tls-cert.sh"
sh "$here/gen-sim-github-app.sh"
docker compose -f docker-compose.e2e.yml up -d --build --wait
# Registered-key SSH e2e are self-contained (each docker-runs its own node + proxy);
# they only need the node image pre-built.
docker build -f services/ssh-gateway/Dockerfile.node -t edd-workspace-node:e2e .

# shellcheck disable=SC1091 # generated at bring-up by gen-sim-github-app.sh
. ./temp/github-app/coords.env
RECONCILER_IMAGE=edd-reconciler:e2e PROXY_IMAGE=edd-ssh-proxy:e2e \
  NODE_IMAGE=edd-workspace-node:e2e pnpm test:e2e
