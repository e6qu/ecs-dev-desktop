#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
unset CDPATH

root=$(cd "$(dirname "$0")/.." && pwd)

if [ "$#" -gt 0 ]; then
  workflow_files=$*
else
  workflow_files=$(find "$root/.github/workflows" -type f \( -name '*.yml' -o -name '*.yaml' \) -print | sort)
fi

[ -n "$workflow_files" ] || {
  echo "edd: no GitHub Actions workflows were found" >&2
  exit 1
}

for workflow in $workflow_files; do
  awk -v workflow="$workflow" '
  function finish_job() {
    if (job != "" && timeout_count == 0) {
      printf "%s: GitHub Actions job %s is missing timeout-minutes\n", workflow, job > "/dev/stderr"
      failed = 1
    }
    job = ""
    timeout_count = 0
  }
  /^jobs:[[:space:]]*$/ {
    in_jobs = 1
    next
  }
  in_jobs && /^[^[:space:]]/ {
    finish_job()
    in_jobs = 0
  }
  in_jobs && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
    finish_job()
    job = $0
    sub(/^  /, "", job)
    sub(/:[[:space:]]*$/, "", job)
    next
  }
  in_jobs && job != "" && /^    timeout-minutes:[[:space:]]*/ {
    timeout_count++
    value = $0
    sub(/^    timeout-minutes:[[:space:]]*/, "", value)
    sub(/[[:space:]]+#.*$/, "", value)
    sub(/[[:space:]]+$/, "", value)
    if (timeout_count > 1) {
      printf "%s: GitHub Actions job %s declares timeout-minutes more than once\n", workflow, job > "/dev/stderr"
      failed = 1
    } else if (value !~ /^[0-9]+$/ || value + 0 < 1 || value + 0 > 15) {
      printf "%s: GitHub Actions job %s timeout-minutes must be a literal integer from 1 through 15, got %s\n", workflow, job, value > "/dev/stderr"
      failed = 1
    }
  }
  END {
    finish_job()
    exit failed
  }
  ' "$workflow"
done

echo "edd: GitHub Actions job timeout contract passed"
