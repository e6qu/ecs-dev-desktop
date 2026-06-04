#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Verify the current branch is on top of its destination branch — i.e. merging it
# into the destination would FAST-FORWARD (the destination is an ancestor of HEAD,
# so the history stays linear and no merge commit is needed). Catches a branch
# that has drifted behind its base before it reaches a merge.
#
# Destination resolution (first hit wins):
#   1. $BASE_BRANCH        (explicit override)
#   2. $GITHUB_BASE_REF    (set on GitHub PR events — the merge target)
#   3. origin/HEAD         (the remote's default branch)
#   4. "main"
#
# Set CHECK_BRANCH_FETCH=1 to refresh the destination ref first (CI); otherwise the
# last-fetched ref is compared (fast + offline — for the pre-commit hook).
#
# Portable: POSIX sh, passes shellcheck, runs under bash and zsh on macOS and Linux.
# No arrays, no Bash-only features; $0-derived behaviour only.

set -eu
unset CDPATH

# Not in a work tree (or no git): nothing to check.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

# Branch name is "HEAD" when detached (e.g. a CI PR checkout) — we then compare by
# commit instead, so detachment is fine.
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")

# Resolve the destination branch name.
dest="${BASE_BRANCH:-}"
if [ -z "$dest" ]; then
  dest="${GITHUB_BASE_REF:-}"
fi
if [ -z "$dest" ]; then
  dest=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
fi
if [ -z "$dest" ]; then
  dest="main"
fi

# Already on the destination branch — nothing to merge into it.
if [ "$branch" = "$dest" ]; then
  exit 0
fi

remote="origin"
dest_ref="$remote/$dest"

if [ "${CHECK_BRANCH_FETCH:-0}" = "1" ]; then
  git fetch --quiet "$remote" "$dest" 2>/dev/null || true
fi

# No remote-tracking destination ref locally — skip rather than fail (e.g. a brand
# new repo, or the remote has not been fetched).
if ! git rev-parse --verify --quiet "$dest_ref" >/dev/null 2>&1; then
  echo "check-branch-current: '$dest_ref' not found; skipping (fetch '$remote' first)."
  exit 0
fi

# HEAD already equals the destination tip: trivially fast-forwardable.
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "$dest_ref")" ]; then
  exit 0
fi

# The check: the destination must be an ancestor of HEAD.
if git merge-base --is-ancestor "$dest_ref" HEAD; then
  exit 0
fi

label="$branch"
if [ "$label" = "HEAD" ]; then
  label="${GITHUB_HEAD_REF:-this branch}"
fi

echo "✗ '$label' is behind '$dest_ref' — merging it would NOT fast-forward." >&2
echo "  Rebase onto the destination so the history stays linear:" >&2
echo "      git fetch $remote $dest && git rebase $dest_ref" >&2
exit 1
