#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Local smoke for the workspace base image + the first-party Monaco editor: build the image via
# build.sh, run it in monaco mode, and confirm the editor serves on :3000. The editor (HTTP + SPA +
# file API) validates on any host; the TERMINAL needs node-pty's Linux native binary, which is
# absent on a macOS/Apple-Silicon host build, so the terminal is exercised only by CI (the e2e
# tier), not here. Requires Docker.
#
# Usage: infra/images/base/smoke.sh
set -eu
unset CDPATH

here=$(cd "$(dirname "$0")" && pwd)
tag="edd-base:smoke"
name="edd-monaco-smoke"
port="${EDD_SMOKE_PORT:-4599}"

"$here/build.sh" "$tag" --load

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# EDD_CONTROL_PLANE_URL/EDD_AGENT_TOKEN satisfy the entrypoint's early required-env checks; the
# tokenless flag lets us curl the editor without the connection-token handshake.
docker run -d --name "$name" \
  -e EDD_EDITOR_MODE=monaco \
  -e EDD_WORKSPACE_ID=ws-smoke \
  -e EDD_DISABLE_CONNECTION_TOKEN=1 \
  -e EDD_CONTROL_PLANE_URL=http://127.0.0.1:9 \
  -e EDD_AGENT_TOKEN=smoke \
  -p "${port}:3000" "$tag" >/dev/null

i=0
while [ "$i" -lt 25 ]; do
  if curl -fsS -o /dev/null "http://127.0.0.1:${port}/w/ws-smoke/"; then
    echo "edd: Monaco editor serves on :${port}/w/ws-smoke/ (OK)"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "edd: Monaco editor did not come up on :${port} within 25s" >&2
docker logs "$name" 2>&1 | tail -20 >&2
exit 1
