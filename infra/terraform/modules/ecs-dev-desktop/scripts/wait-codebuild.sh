#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Start a CodeBuild build and poll until it succeeds or fails. Called by
# terraform's local-exec in build-codebuild mode. POSIX sh.
set -eu
unset CDPATH

project="${1:?project name}"
region="${2:?region}"

echo "edd: starting CodeBuild project $project"
build_id=$(aws codebuild start-build --project-name "$project" --region "$region" \
  --query 'build.id' --output text)

echo "edd: waiting for build $build_id"
while true; do
  sleep 15
  status=$(aws codebuild batch-get-builds --ids "$build_id" --region "$region" \
    --query 'builds[0].buildStatus' --output text)
  echo "  status: $status"
  case "$status" in
    SUCCEEDED)
      echo "edd: build succeeded"
      exit 0
      ;;
    FAILED | STOPPED | TIMED_OUT)
      echo "edd: build failed with status $status" >&2
      exit 1
      ;;
    IN_PROGRESS) ;;
    *) echo "edd: unknown status $status, continuing" ;;
  esac
done
