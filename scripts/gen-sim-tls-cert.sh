#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Generate a self-signed CA + server cert for running the sockerless simulators
# over TLS in the HTTPS e2e harness (docker-compose.https.yml). Output dir
# (default ./temp/sim-tls):
#   ca.pem          the CA cert — clients trust it via NODE_EXTRA_CA_CERTS
#   server.pem      the server cert — mounted into each sim as SIM_TLS_CERT
#   server-key.pem  the server key  — mounted into each sim as SIM_TLS_KEY
#
# The server cert's SANs cover both how the host reaches the sims (127.0.0.1 /
# localhost) and how containers reach each other by compose service name
# (azure-sim / aws-sim / bleephub). No private key is committed — the cert is
# regenerated on each harness bring-up (temp/ is gitignored).
#
# Portable: POSIX sh, passes shellcheck, runs under bash and zsh on macOS+Linux.
# Uses an -extfile (not -addext) so it works on both OpenSSL and macOS LibreSSL.

set -eu
unset CDPATH

out_dir="${1:-./temp/sim-tls}"
mkdir -p "$out_dir"

# Loopback (host -> sim) + the compose service names (container -> container).
san="IP:127.0.0.1,DNS:localhost,DNS:azure-sim,DNS:aws-sim,DNS:bleephub,DNS:host.docker.internal"

# 1. Certificate authority (its cert is what clients trust).
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 \
  -keyout "$out_dir/ca-key.pem" -out "$out_dir/ca.pem" \
  -subj "/CN=edd-sim-test-ca" >/dev/null 2>&1

# 2. Server key + CSR.
openssl req -newkey rsa:2048 -nodes \
  -keyout "$out_dir/server-key.pem" -out "$out_dir/server.csr" \
  -subj "/CN=edd-sim" >/dev/null 2>&1

# 3. Sign the server cert with the SANs + serverAuth EKU.
ext_file="$out_dir/server-ext.cnf"
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san" >"$ext_file"
openssl x509 -req -in "$out_dir/server.csr" \
  -CA "$out_dir/ca.pem" -CAkey "$out_dir/ca-key.pem" -CAcreateserial \
  -days 3650 -sha256 -extfile "$ext_file" -out "$out_dir/server.pem" >/dev/null 2>&1

# Keep only what the harness consumes: ca.pem, server.pem, server-key.pem.
rm -f "$out_dir/server.csr" "$out_dir/server-ext.cnf" "$out_dir/ca.srl" "$out_dir/ca-key.pem"

# World-readable: the cert is mounted read-only into sim containers that run as
# non-root users (e.g. bleephub uid 10001). This is a throwaway test cert, never
# committed (temp/ is gitignored) and never a real secret.
chmod 644 "$out_dir/ca.pem" "$out_dir/server.pem" "$out_dir/server-key.pem"

echo "sim TLS cert generated in $out_dir (SANs: $san)"
