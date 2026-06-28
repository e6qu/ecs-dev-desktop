#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Wrapper called by terraform's local-exec in build-local mode. Assumes the
# current working directory is the repo root (terraform sets working_dir to
# local_build_context_path). Invokes scripts/publish-images.sh. POSIX sh.
set -eu
unset CDPATH

account="${1:?account id}"
region="${2:?region}"
name="${3:?name}"
tag="${4:?tag}"
shift 4
sh scripts/publish-images.sh "$account" "$region" "$name" "$tag" "$@"
