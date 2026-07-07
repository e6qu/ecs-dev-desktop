#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# webServer command for playwright.live.config.ts: provision the live cloud
# state (tsx script writes temp/live-pw.env), then start the production build
# on the live config's fixed port with that environment.
set -eu
unset CDPATH
unset NO_COLOR

# Run from apps/web regardless of the caller's cwd ($0-derived, POSIX).
cd -- "$(dirname -- "$0")/.."

pnpm run test:pw:live:provision

# shellcheck disable=SC1091
. ./temp/live-pw.env

pnpm exec next build
# The custom server (server.ts) is the production entrypoint — it serves the app AND
# the path-based `/w/<id>/` editor proxy, so the live browser test exercises the real
# proxy path. Bind 0.0.0.0 (workspace containers reach it over the host network).
exec env NODE_ENV=production PORT=3220 HOSTNAME=0.0.0.0 pnpm exec tsx server.ts
