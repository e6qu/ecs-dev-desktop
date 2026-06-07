#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Generate an ephemeral SSH CA for the SSH e2e harness (docker-compose.ssh.yml).
# Output: temp/ssh-ca/ca (private key) and temp/ssh-ca/ca.pub (public key).
#
# The public key is mounted into the workspace-node container as TrustedUserCAKeys.
# The private key is used by the test (ssh-connect.e2e.ts) to sign short-lived user
# certificates; it is never committed (temp/ is gitignored).
#
# Portable: POSIX sh, passes shellcheck, runs under bash and zsh on macOS+Linux.
# Idempotent: overwrites any existing key to ensure the mounted pub key matches.

set -eu
unset CDPATH

OUTDIR="${1:-services/ssh-gateway/temp/ssh-ca}"
mkdir -p "${OUTDIR}"

# Ed25519 host CA — small, fast, widely supported by modern OpenSSH.
# -N ""   no passphrase (test use only)
# -f      output path (ssh-keygen appends .pub for the public key)
# -C      comment identifying this as a test credential
ssh-keygen -q -t ed25519 -N "" \
  -f "${OUTDIR}/ca" \
  -C "edd-e2e-ssh-ca-$(date +%Y%m%d)" \
  </dev/null
