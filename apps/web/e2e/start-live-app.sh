#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# webServer command for playwright.live.config.ts: provision the live cloud
# state (tsx script writes temp/live-pw.env), then start the production build
# on the live config's fixed port with that environment.
set -eu
unset CDPATH

# Run from apps/web regardless of the caller's cwd ($0-derived, POSIX).
cd -- "$(dirname -- "$0")/.."

pnpm run test:pw:live:provision

# shellcheck disable=SC1091
. ./temp/live-pw.env

pnpm exec next build
exec pnpm exec next start -p 3220
