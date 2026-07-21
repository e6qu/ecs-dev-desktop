#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
unset CDPATH

owner=${1:?usage: retain-ghcr-package-versions.sh <owner> <package> [keep]}
package_name=${2:?usage: retain-ghcr-package-versions.sh <owner> <package> [keep]}
keep=${3:-20}

case $keep in
  '' | *[!0-9]*)
    echo "edd: retained version count must be a positive integer" >&2
    exit 2
    ;;
esac
if [ "$keep" -lt 1 ]; then
  echo "edd: retained version count must be at least one" >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || {
  echo "edd: GitHub CLI is required for fixture retention" >&2
  exit 2
}

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/edd-ghcr-retention.XXXXXX")
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup 0 1 2 15

max_attempts=4
request_number=0

api_call() {
  operation=$1
  shift
  request_number=$((request_number + 1))
  stdout="$tmpdir/stdout.$request_number"
  stderr="$tmpdir/stderr.$request_number"
  attempt=1

  while :; do
    : >"$stdout"
    : >"$stderr"
    if gh api "$@" >"$stdout" 2>"$stderr"; then
      cat "$stderr" >&2
      cat "$stdout"
      return 0
    else
      status=$?
    fi

    if [ "$operation" = delete ] && grep -Eqi 'HTTP 404|Not Found' "$stderr"; then
      echo "edd: package version was already absent after an ambiguous delete" >&2
      return 0
    fi

    if ! grep -Eqi 'HTTP (408|429|500|502|503|504)|timed? out|timeout|connection (reset|refused)|temporary failure|unexpected EOF' "$stderr"; then
      cat "$stderr" >&2
      return "$status"
    fi
    if [ "$attempt" -ge "$max_attempts" ]; then
      cat "$stderr" >&2
      echo "edd: GitHub API remained unavailable after $max_attempts attempts" >&2
      return "$status"
    fi

    delay=$((attempt * 2))
    cat "$stderr" >&2
    echo "edd: transient GitHub API failure; retrying in ${delay}s (${attempt}/${max_attempts})" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

owner_type=$(api_call list "/users/${owner}" --jq .type)
case $owner_type in
  Organization) scope=orgs ;;
  User) scope=users ;;
  *)
    echo "edd: unsupported package owner type: $owner_type" >&2
    exit 1
    ;;
esac

endpoint="/${scope}/${owner}/packages/container/${package_name}/versions"
stale=$(api_call list --paginate "${endpoint}?per_page=100" \
  --jq '.[] | [.created_at, .id] | @tsv' | sort -r | tail -n "+$((keep + 1))" | cut -f2)

for version in $stale; do
  api_call delete --method DELETE "${endpoint}/${version}" >/dev/null
done
