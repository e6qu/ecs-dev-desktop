#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Local smoke for the workspace base image interfaces: build the image via
# build.sh, run the Monaco and vendor-harness modes, and confirm each serves on
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

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

smoke_mode() {
  mode=$1
  path=$2
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
  while [ "$i" -lt 25 ]; do
    if curl -fsS -o /dev/null "http://127.0.0.1:${port}${path}"; then
      echo "edd: ${mode} serves ${path} on :${port} (OK)"
      cleanup
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done

  echo "edd: ${mode} did not come up on :${port}${path} within 25s" >&2
  docker logs "$name" 2>&1 | tail -20 >&2
  exit 1
}

smoke_mode monaco /w/ws-smoke/
smoke_mode claude /w/ws-smoke/healthz
smoke_mode codex /w/ws-smoke/healthz
