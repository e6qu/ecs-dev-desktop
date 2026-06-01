#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Strip AI attribution trailers (and trailing whitespace) from commit messages.
# Wired as a pre-commit `commit-msg`-stage hook. Portable: passes shellcheck and
# runs under bash and zsh, on macOS and Linux. (Mirrors sockerless's approach.)
set -eu
set -o pipefail

msg_file="$1"

# Portable in-place sed (BSD/macOS requires an explicit empty suffix argument).
sedi() {
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# Strip trailing whitespace from every line.
sedi 's/[[:space:]]*$//' "$msg_file"

# Drop "Generated with <AI tool>" lines (e.g. the Claude Code marker).
sedi -E '/[Gg]enerated with \[?(Claude|Copilot|GPT|Cursor)/d' "$msg_file"

# Drop Co-authored-by / Authored-by / Generated-by trailers naming AI tools.
ai='(Claude|Copilot|GPT|Anthropic|OpenAI|AI |[Aa]rtificial|[Aa]ssistant|[Bb]ot)'
sedi -E "/^[Cc]o-[Aa]uthored-[Bb]y:.*${ai}/d" "$msg_file"
sedi -E "/^[Aa]uthored-[Bb]y:.*${ai}/d" "$msg_file"
sedi -E "/^[Gg]enerated-[Bb]y:.*${ai}/d" "$msg_file"

# Remove trailing blank lines left behind.
while [ -s "$msg_file" ] && [ -z "$(tail -1 "$msg_file" | tr -d '[:space:]')" ]; do
  sedi '$ d' "$msg_file"
done
