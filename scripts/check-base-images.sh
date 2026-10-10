#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Every external image a Dockerfile builds FROM is pulled from a registry that
# does not limit anonymous pulls the way Docker Hub does, and is pinned by tag
# AND digest. Docker Hub limits anonymous pulls per source address, and GitHub's
# shared runners exhaust that limit for everyone on them, so an unqualified
# `FROM node:22` fails CI for reasons this repository cannot control. The tag
# keeps the pin readable and lets scripts/check-image-pins.mjs find the newer
# digest; the digest makes two builds of one Dockerfile start from the same bytes.
#
# Allowed on a FROM line: a build argument (`${BASE}`; its default is checked
# where it is set), an earlier stage of the same file, or
#   <registry>/<path>:<tag>@sha256:<64 hex>
# with <registry> one of public.ecr.aws, mirror.gcr.io, ghcr.io, gcr.io, quay.io.
set -eu
unset CDPATH
cd "$(dirname "$0")/.."

fail=0
# This project's own published images (the simulators) are pinned by digest
# alone; scripts/check-sim-pins.sh keeps those pins in step.
pinned='^((public\.ecr\.aws|mirror\.gcr\.io|ghcr\.io|gcr\.io|quay\.io)/[a-z0-9._/-]+:[A-Za-z0-9._-]+|ghcr\.io/e6qu/[a-z0-9._/-]+)@sha256:[0-9a-f]{64}$'

while IFS= read -r f; do
  stages=" "
  while read -r image name; do
    case "$image" in
      '$'*) ;;
      *)
        case "$stages" in
          *" $image "*) ;;
          *)
            if ! printf '%s\n' "$image" | grep -Eq "$pinned"; then
              echo "check-base-images: $f builds FROM '$image', which is not <allowed registry>/<path>:<tag>@sha256:<digest>" >&2
              fail=1
            fi
            ;;
        esac
        ;;
    esac
    # Later `FROM <stage>` lines refer to this stage, not to a registry.
    [ "$name" = "-" ] || stages="$stages$name "
  done <<EOF
$(grep -iE '^FROM[[:space:]]' "$f" | awk '{ i = 2; if ($i ~ /^--platform=/) i++; n = "-"; for (j = i + 1; j <= NF; j++) if (toupper($j) == "AS") n = $(j + 1); print $i, n }')
EOF
  # A build argument named in FROM must default to a pinned external image or a
  # local tag this repository builds itself (`edd-...`).
  grep -oE '^FROM[[:space:]]+(--platform=[^[:space:]]+[[:space:]]+)?\$\{?[A-Z_]+' "$f" | grep -oE '[A-Z_]+$' |
    while read -r arg; do
      default=$(grep -E "^ARG ${arg}=" "$f" | head -n 1 | sed -E "s/^ARG ${arg}=//")
      case "$default" in
        edd-*) ;;
        *)
          if ! printf '%s\n' "$default" | grep -Eq "$pinned"; then
            echo "check-base-images: $f defaults ARG $arg to '$default', which is not a pinned image from an allowed registry" >&2
            exit 1
          fi
          ;;
      esac
    done || fail=1
done <<EOF
$(git ls-files '*Dockerfile' '*Dockerfile.*' '*.Dockerfile' | grep -v '\.dockerignore$')
EOF

# CI boots its BuildKit builder from this image; the action's default pulls it
# from Docker Hub.
if ! grep -Eq '^buildkit_image="mirror\.gcr\.io/moby/buildkit:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}"$' scripts/setup-buildx.sh; then
  echo "check-base-images: scripts/setup-buildx.sh must boot BuildKit from mirror.gcr.io, pinned by digest" >&2
  fail=1
fi
if git grep -nE 'docker/setup-buildx-action' -- .github >/dev/null; then
  echo "check-base-images: use scripts/setup-buildx.sh, not docker/setup-buildx-action (it pulls BuildKit from Docker Hub):" >&2
  git grep -nE 'docker/setup-buildx-action' -- .github >&2
  fail=1
fi

[ "$fail" -eq 0 ] && echo "check-base-images: every Dockerfile base is pinned by digest outside Docker Hub"
exit "$fail"
