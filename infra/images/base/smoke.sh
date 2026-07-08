#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Local smoke for the workspace base image interfaces: build the image via
# build.sh, run every editor mode, and confirm each serves its browser UI on
# :3000. The terminal is exercised in CI by the e2e tier. Requires Docker.
#
# Usage: infra/images/base/smoke.sh
set -eu
unset CDPATH

here=$(cd "$(dirname "$0")" && pwd)
tag="edd-base:smoke"
name="edd-workspace-smoke"
port="${EDD_SMOKE_PORT:-4599}"

"$here/build.sh" "$tag" --load
docker run --rm --entrypoint sh "$tag" -lc 'command -v bwrap >/dev/null'

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

smoke_mode() {
  mode=$1
  cleanup
  # EDD_CONTROL_PLANE_URL/EDD_AGENT_TOKEN satisfy the entrypoint's early required-env checks; the
  # tokenless flag lets us curl the editor/harness without the connection-token handshake.
  docker run -d --name "$name" \
    -e EDD_EDITOR_MODE="$mode" \
    -e EDD_WORKSPACE_ID=ws-smoke \
    -e EDD_DISABLE_CONNECTION_TOKEN=1 \
    -e EDD_CONTROL_PLANE_URL=http://127.0.0.1:9 \
    -e EDD_AGENT_TOKEN=smoke \
    -p "${port}:3000" "$tag" >/dev/null

  i=0
  path=/w/ws-smoke/
  while [ "$i" -lt 25 ]; do
    body=$(curl -fsS "http://127.0.0.1:${port}${path}" 2>/dev/null) && {
      case "$body" in
        *"Vendor harness log"* | *"Open the vendor "*)
          echo "edd: ${mode} served the removed EDD vendor wrapper" >&2
          exit 1
          ;;
      esac
      echo "edd: ${mode} serves ${path} on :${port} (OK)"
      cleanup
      return 0
    }
    i=$((i + 1))
    sleep 1
  done

  echo "edd: ${mode} did not come up on :${port}${path} within 25s" >&2
  docker logs "$name" 2>&1 | tail -20 >&2
  exit 1
}

smoke_mode openvscode
smoke_mode monaco
smoke_mode claude
smoke_mode codex
