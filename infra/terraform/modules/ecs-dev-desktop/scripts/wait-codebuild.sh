#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Start a CodeBuild build and poll until it succeeds or fails. Called by
# terraform's local-exec in build-codebuild mode. POSIX sh.
#
# The build's service role is created by the same apply, moments before this
# runs, and IAM is eventually consistent: AWS documents that a new role or
# policy can take some seconds to be honoured everywhere. CodeBuild picks the
# role up at submission, so a build started inside that window fails before
# it runs a single command — status FAILED with the fault in the QUEUED or
# PROVISIONING phase and an AccessDenied for the first API the role needs
# (`logs:CreateLogStream`). That exact failure, and only that one, is the
# role not having propagated yet; the build is started again, a bounded number
# of times. A build that fails any other way, or once it is running, fails
# this script the way it always did.
set -eu
unset CDPATH

project="${1:?project name}"
region="${2:?region}"

# How many times a build refused for a not-yet-propagated role is restarted,
# 15 s apart: IAM propagation is measured in seconds, so this is minutes of
# headroom, not an open-ended loop.
max_restarts=8
restarts=0

start_build() {
  echo "edd: starting CodeBuild project $project"
  build_id=$(aws codebuild start-build --project-name "$project" --region "$region" \
    --query 'build.id' --output text)
  echo "edd: waiting for build $build_id"
}

# The failing phase and the fault's message, for a build that just FAILED.
failure_signature() {
  aws codebuild batch-get-builds --ids "$build_id" --region "$region" \
    --query "builds[0].phases[?phaseStatus=='FAULT'] | [0].[phaseType, contexts[0].message]" \
    --output text
}

start_build
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
    FAILED)
      signature=$(failure_signature)
      phase=$(printf '%s\n' "$signature" | cut -f1)
      message=$(printf '%s\n' "$signature" | cut -f2-)
      echo "edd: build $build_id failed in phase $phase: $message" >&2
      case "$phase:$message" in
        QUEUED:*AccessDenied* | QUEUED:*not\ authorized* | PROVISIONING:*AccessDenied* | PROVISIONING:*not\ authorized*)
          if [ "$restarts" -ge "$max_restarts" ]; then
            echo "edd: the build's service role still is not honoured after $restarts restarts; giving up" >&2
            exit 1
          fi
          restarts=$((restarts + 1))
          echo "edd: the service role has not propagated yet (restart $restarts of $max_restarts)"
          start_build
          ;;
        *)
          exit 1
          ;;
      esac
      ;;
    STOPPED | TIMED_OUT)
      echo "edd: build failed with status $status" >&2
      exit 1
      ;;
    IN_PROGRESS) ;;
    *) echo "edd: unknown status $status, continuing" ;;
  esac
done
