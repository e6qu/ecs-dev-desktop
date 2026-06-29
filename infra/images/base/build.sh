#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Build the base workspace image. Stages the architecture-independent first-party
# Monaco editor server (@edd/editor-monaco) bundle into this build context, then
# runs `docker build`. The native `node-pty` binding is compiled INSIDE the image
# for the target architecture (base/Dockerfile multi-stage builder), so the same
# host can produce correct amd64 and arm64 images.
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

# The only runtime native dependency is node-pty. We stage a minimal package.json
# so the Dockerfile builder stage installs/compiles it for the target architecture.
node_pty_version=$(node -p "require('$repo/services/editor-monaco/package.json').dependencies['node-pty']")
cat >"$stage/package.json" <<EOF
{
  "name": "@edd/editor-monaco-runtime",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "node-pty": "$node_pty_version"
  }
}
EOF

# Use `docker buildx build` when the caller passes buildx-specific flags
# (--platform, --push, --load, --builder), otherwise keep the classic `docker build`
# behaviour so local one-off builds load into the docker daemon by default.
#
# Podman exposes a Docker-compatible API, but the default `docker buildx` builder on
# a Podman machine is the `docker-container` driver: images stay inside the BuildKit
# container and are not visible to a subsequent `docker build` for `FROM` resolution.
# Detect a Podman backend and use `podman build` directly so the image is loaded into
# the local store. CI uses a real Docker daemon and keeps the docker path.
use_buildx=false
for a; do
  case $a in
    --platform | --push | --load | --builder | --cache-from | --cache-to) use_buildx=true ;;
  esac
done

if [ "$use_buildx" = true ]; then
  echo "edd: docker buildx build -t ${tag} $*"
  docker buildx build -t "$tag" "$@" "$here"
elif docker version 2>/dev/null | grep -q 'Podman Engine'; then
  echo "edd: podman build -t ${tag}"
  podman build -t "$tag" "$@" "$here"
else
  echo "edd: docker build -t ${tag}"
  docker build -t "$tag" "$@" "$here"
fi
