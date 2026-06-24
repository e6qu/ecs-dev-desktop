#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Build the base workspace image. Stages the first-party Monaco editor server
# (@edd/editor-monaco) into this build context, then runs `docker build`. The base
# image MUST be built this way (not a bare `docker build infra/images/base`) so the
# bundled editor + its native runtime node_modules are present for the Dockerfile COPY.
#
# Usage: infra/images/base/build.sh <image-tag> [extra docker build args...]
set -eu
unset CDPATH

tag="${1:?usage: build.sh <image-tag> [extra docker build args...]}"
shift

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
stage="$here/editor-monaco"

echo "edd: building @edd/editor-monaco + staging into the base image context"
(cd "$repo" && pnpm --filter @edd/editor-monaco build)

rm -rf "$stage"
mkdir -p "$stage/spa"
cp "$repo/services/editor-monaco/dist/server.js" "$stage/server.js"
cp -R "$repo/services/editor-monaco/dist/spa/." "$stage/spa/"

# Runtime node_modules (node-pty's native binding). pnpm deploy resolves the workspace
# symlinks into a real, self-contained tree; built for THIS host's platform (so in CI on
# Linux it produces the Linux binary the image needs).
deploy="$here/.editor-deploy"
rm -rf "$deploy"
(cd "$repo" && pnpm --filter @edd/editor-monaco deploy --legacy --prod "$deploy")
cp -RL "$deploy/node_modules" "$stage/node_modules"
rm -rf "$deploy"

echo "edd: docker build -t ${tag}"
docker build -t "$tag" "$@" "$here"
