#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for Route53 DNS resolution.
# Proves that records created via the Route53 HTTP API are resolvable through
# the authoritative DNS server, matching the behavior the ecs-dev-desktop
# module depends on for `app.<domain>` and `*.<ssh-base-domain>`.
# Endpoint-only: targets AWS_ENDPOINT_URL from the environment (sockerless sim or real AWS).
set -eu
unset CDPATH

endpoint="${AWS_ENDPOINT_URL:-http://127.0.0.1:4566}"
region="${AWS_REGION:-us-east-1}"
# The sim's Route53 DNS server binds an ephemeral UDP port in process mode and
# is published at port 15353 in the docker-compose.tier2.yml harness. The probe
# must know which port to query; CI sets DNS_PORT=15353, and local runs can
# override it if the sim was started on a different port.
: "${DNS_PORT:=15353}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"

aws() {
  command aws --endpoint-url "$endpoint" --region "$region" "$@"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

suffix="$(date +%s)"
domain="edd-probe-${suffix}.local"
zone_id=""

# Keep the probe self-contained: create the zone, exercise it, then delete it.
cleanup() {
  if [ -n "$zone_id" ]; then
    aws route53 delete-hosted-zone --id "$zone_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "=== Route53: create public hosted zone for ${domain} ==="
zone_out=$(aws route53 create-hosted-zone \
  --name "$domain" \
  --caller-ref "edd-probe-${suffix}" \
  --output json)
zone_id=$(printf '%s\n' "$zone_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["HostedZone"]["Id"].split("/")[-1])')
if [ -z "$zone_id" ]; then
  fail "CreateHostedZone did not return a zone id"
fi
pass "Created hosted zone ${zone_id} for ${domain}"

echo "=== Route53: retrieve zone NS records ==="
ns_records=$(aws route53 list-resource-record-sets \
  --hosted-zone-id "$zone_id" \
  --query "ResourceRecordSets[?Type=='NS'].ResourceRecords[*].Value" \
  --output text)
ns_count=$(echo "$ns_records" | wc -w | tr -d ' ')
if [ "$ns_count" -lt 2 ]; then
  fail "Expected at least 2 NS records, got ${ns_count}: ${ns_records}"
fi
pass "Zone has ${ns_count} NS records"

echo "=== Route53: create A record (app -> 1.2.3.4) ==="
aws route53 change-resource-record-sets \
  --hosted-zone-id "$zone_id" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"CREATE\",
      \"ResourceRecordSet\": {
        \"Name\": \"app.${domain}\",
        \"Type\": \"A\",
        \"TTL\": 60,
        \"ResourceRecords\": [{\"Value\": \"1.2.3.4\"}]
      }
    }]
  }" >/dev/null || fail "CREATE A record rejected"
pass "Created A record app.${domain} -> 1.2.3.4"

echo "=== Route53: create CNAME wildcard (wildcard -> app) ==="
aws route53 change-resource-record-sets \
  --hosted-zone-id "$zone_id" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"CREATE\",
      \"ResourceRecordSet\": {
        \"Name\": \"*.${domain}\",
        \"Type\": \"CNAME\",
        \"TTL\": 60,
        \"ResourceRecords\": [{\"Value\": \"app.${domain}\"}]
      }
    }]
  }" >/dev/null || fail "CREATE wildcard CNAME rejected"
pass "Created CNAME wildcard *.${domain} -> app.${domain}"

# Choose a DNS query tool. dig is preferred; drill or nslookup are fallbacks.
# $1 = name, $2 = query type (defaults to A).
dns_query() {
  name="$1"
  qtype="${2:-A}"
  if command -v dig >/dev/null 2>&1; then
    dig @127.0.0.1 -p "$DNS_PORT" "$name" "$qtype" +short +time=5 +tries=2 || true
  elif command -v drill >/dev/null 2>&1; then
    drill @127.0.0.1 -p "$DNS_PORT" "$name" "$qtype" 2>/dev/null | awk '/^'"$(echo "$name" | sed 's/\./\\./g')"'\./{print $5}' || true
  else
    nslookup -port="$DNS_PORT" -type="$qtype" "$name" 127.0.0.1 2>/dev/null | awk '/^Address: /{print $2}' | tail -n1 || true
  fi
}

echo "=== DNS: query NS records from the authoritative server ==="
queried_ns=$(dns_query "$domain" NS)
# The NS query should return the same hostnames the API reported.
missing=0
for ns in $ns_records; do
  ns_clean=$(echo "$ns" | sed 's/\.$//')
  if ! echo "$queried_ns" | grep -qF "$ns_clean"; then
    missing=$((missing + 1))
    echo "WARN: NS ${ns_clean} not returned by DNS query" >&2
  fi
done
if [ "$missing" -gt 0 ]; then
  fail "DNS NS query did not return all expected nameservers"
fi
pass "DNS NS query returns expected nameservers"

echo "=== DNS: resolve A record app.${domain} ==="
a_answer=$(dns_query "app.${domain}")
if [ "$a_answer" != "1.2.3.4" ]; then
  fail "Expected A record 1.2.3.4, got: ${a_answer}"
fi
pass "A record app.${domain} resolves to 1.2.3.4"

echo "=== DNS: resolve wildcard CNAME for foo.${domain} ==="
wildcard_answer=$(dns_query "foo.${domain}" CNAME)
if ! echo "$wildcard_answer" | grep -qF "app.${domain}"; then
  fail "Expected wildcard CNAME to point to app.${domain}, got: ${wildcard_answer}"
fi
pass "Wildcard CNAME foo.${domain} points to app.${domain}"

echo "=== ALL ROUTE53 DNS ADVERSARIAL SLICE PROBES PASSED ==="
