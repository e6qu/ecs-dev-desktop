#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for ACM certificate issuance and
# ALB HTTPS TLS termination.
# Proves that ACM issues an AMAZON_ISSUED certificate for app.<domain> and that
# an Application Load Balancer HTTPS listener terminates TLS using it.
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
fqdn="app.${domain}"
# Spread ALB HTTPS listeners across a non-privileged port range to reduce the
# chance of colliding with a leaked listener from an earlier run.
listener_port=$((8443 + suffix % 1000))

zone_id=""
cert_arn=""
vpc_id=""
subnet_id=""
alb_sg=""
alb_arn=""
tg_arn=""
listener_arn=""

cleanup() {
  if [ -n "${listener_arn:-}" ]; then
    aws elbv2 delete-listener --listener-arn "$listener_arn" >/dev/null 2>&1 || true
  fi
  if [ -n "${tg_arn:-}" ]; then
    aws elbv2 delete-target-group --target-group-arn "$tg_arn" >/dev/null 2>&1 || true
  fi
  if [ -n "${alb_arn:-}" ]; then
    aws elbv2 delete-load-balancer --load-balancer-arn "$alb_arn" >/dev/null 2>&1 || true
  fi
  if [ -n "${alb_sg:-}" ]; then
    aws ec2 delete-security-group --group-id "$alb_sg" >/dev/null 2>&1 || true
  fi
  if [ -n "${subnet_id:-}" ]; then
    aws ec2 delete-subnet --subnet-id "$subnet_id" >/dev/null 2>&1 || true
  fi
  if [ -n "${vpc_id:-}" ]; then
    aws ec2 delete-vpc --vpc-id "$vpc_id" >/dev/null 2>&1 || true
  fi
  if [ -n "${zone_id:-}" ]; then
    aws route53 delete-hosted-zone --id "$zone_id" >/dev/null 2>&1 || true
  fi
  if [ -n "${cert_arn:-}" ]; then
    aws acm delete-certificate --certificate-arn "$cert_arn" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "=== ACM: request DNS-validated certificate for ${fqdn} ==="
cert_arn=$(aws acm request-certificate \
  --domain-name "$fqdn" \
  --validation-method DNS \
  --idempotency-token "edd-acm-${suffix}" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["CertificateArn"])')
if [ -z "$cert_arn" ]; then
  fail "RequestCertificate did not return an ARN"
fi
pass "Requested certificate ${cert_arn}"

echo "=== ACM: certificate type is AMAZON_ISSUED ==="
cert_type=$(aws acm describe-certificate \
  --certificate-arn "$cert_arn" \
  --query 'Certificate.Type' \
  --output text)
if [ "$cert_type" != "AMAZON_ISSUED" ]; then
  fail "Expected certificate type AMAZON_ISSUED, got ${cert_type}"
fi
pass "Certificate type is AMAZON_ISSUED"

echo "=== Route53: create hosted zone for ${domain} ==="
zone_id=$(aws route53 create-hosted-zone \
  --name "$domain" \
  --caller-reference "edd-acm-${suffix}" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["HostedZone"]["Id"].split("/")[-1])')
if [ -z "$zone_id" ]; then
  fail "CreateHostedZone did not return a zone id"
fi
pass "Created hosted zone ${zone_id}"

echo "=== ACM: retrieve DNS validation record ==="
cert_desc=$(aws acm describe-certificate --certificate-arn "$cert_arn" --output json)
record_name=$(echo "$cert_desc" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["Certificate"]["DomainValidationOptions"][0]["ResourceRecord"]["Name"])')
record_value=$(echo "$cert_desc" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["Certificate"]["DomainValidationOptions"][0]["ResourceRecord"]["Value"])')
if [ -z "$record_name" ] || [ -z "$record_value" ]; then
  fail "DescribeCertificate did not return a validation record"
fi
pass "Validation record: ${record_name} -> ${record_value}"

echo "=== Route53: create ACM validation CNAME ==="
aws route53 change-resource-record-sets \
  --hosted-zone-id "$zone_id" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"CREATE\",
      \"ResourceRecordSet\": {
        \"Name\": \"$record_name\",
        \"Type\": \"CNAME\",
        \"TTL\": 60,
        \"ResourceRecords\": [{\"Value\": \"$record_value\"}]
      }
    }]
  }" >/dev/null || fail "CREATE validation CNAME rejected"
pass "Created validation CNAME"

echo "=== ACM: wait for certificate ISSUED ==="
cert_status=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  cert_status=$(aws acm describe-certificate --certificate-arn "$cert_arn" --query 'Certificate.Status' --output text)
  if [ "$cert_status" = "ISSUED" ]; then
    break
  fi
  sleep 1
done
if [ "$cert_status" != "ISSUED" ]; then
  fail "Certificate did not reach ISSUED, got ${cert_status}"
fi
pass "Certificate reached ISSUED"

echo "=== ACM: retrieve and validate certificate PEM ==="
cert_pem=$(aws acm get-certificate --certificate-arn "$cert_arn" --query 'Certificate' --output text)
if ! printf '%s\n' "$cert_pem" | head -n1 | grep -q '^-----BEGIN CERTIFICATE-----'; then
  fail "ACM certificate is not a valid PEM"
fi
pass "Certificate is a real PEM"

echo "=== EC2: create VPC, subnet, and ALB security group ==="
vpc_id=$(aws ec2 create-vpc --cidr-block "10.89.0.0/16" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Vpc"]["VpcId"])')
subnet_id=$(aws ec2 create-subnet \
  --vpc-id "$vpc_id" \
  --cidr-block "10.89.1.0/24" \
  --availability-zone us-east-1a \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Subnet"]["SubnetId"])')
alb_sg=$(aws ec2 create-security-group \
  --group-name "edd-alb-${suffix}" \
  --description "ALB security group for ACM TLS probe" \
  --vpc-id "$vpc_id" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["GroupId"])')
aws ec2 authorize-security-group-ingress \
  --group-id "$alb_sg" \
  --protocol tcp \
  --port "$listener_port" \
  --cidr 0.0.0.0/0 >/dev/null || fail "authorize ingress on ${listener_port} rejected"
pass "Created VPC, subnet, and ALB security group"

echo "=== ELBv2: create application load balancer ==="
alb_arn=$(aws elbv2 create-load-balancer \
  --name "edd-acm-${suffix}" \
  --subnets "$subnet_id" \
  --security-groups "$alb_sg" \
  --type application \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["LoadBalancers"][0]["LoadBalancerArn"])')
alb_dns=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns "$alb_arn" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["LoadBalancers"][0]["DNSName"])')
pass "Created ALB ${alb_dns}"

echo "=== ELBv2: create HTTP target group ==="
tg_arn=$(aws elbv2 create-target-group \
  --name "edd-acm-tg-${suffix}" \
  --protocol HTTP \
  --port 80 \
  --vpc-id "$vpc_id" \
  --target-type ip \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["TargetGroups"][0]["TargetGroupArn"])')
pass "Created target group"

echo "=== ELBv2: create HTTPS listener with ACM certificate ==="
listener_arn=$(aws elbv2 create-listener \
  --load-balancer-arn "$alb_arn" \
  --protocol HTTPS \
  --port "$listener_port" \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
  --certificates CertificateArn="$cert_arn" \
  --default-actions Type=forward,TargetGroupArn="$tg_arn" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Listeners"][0]["ListenerArn"])')
pass "Created HTTPS listener ${listener_arn}"

# Diagnostic: verify the TLS proxy data plane is reachable on loopback.
echo "=== DIAG: checking TLS listener reachability on 127.0.0.1:${listener_port} ==="
reachable=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if (exec 3<>"/dev/tcp/127.0.0.1/${listener_port}") 2>/dev/null; then
    reachable=1
    break
  fi
  sleep 1
done
if [ "$reachable" != 1 ]; then
  echo "DIAG: TLS listener not reachable on 127.0.0.1:${listener_port}" >&2
  echo "DIAG: listening ports on host:" >&2
  (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || true) >&2
  echo "DIAG: ALB DNS name: ${alb_dns}" >&2
fi

echo "=== Route53: create A record ${fqdn} -> 127.0.0.1 ==="
# The sim's ALB TLS proxy binds the listener port on the host loopback. A real
# AWS deployment would use an alias A record pointing at the ALB; here we target
# the loopback address the sim's TLS data plane is reachable on.
aws route53 change-resource-record-sets \
  --hosted-zone-id "$zone_id" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"CREATE\",
      \"ResourceRecordSet\": {
        \"Name\": \"$fqdn\",
        \"Type\": \"A\",
        \"TTL\": 60,
        \"ResourceRecords\": [{\"Value\": \"127.0.0.1\"}]
      }
    }]
  }" >/dev/null || fail "CREATE A record rejected"
pass "Created A record"

# Choose a DNS query tool. dig is preferred; drill or nslookup are fallbacks.
# If DNS_PORT is set, query the sim's authoritative DNS server (CI/local sim);
# otherwise use the system resolver (real AWS).
# Follows CNAME chains up to 5 hops.
dns_query() {
  name="$1"
  hops=0
  while [ "$hops" -lt 5 ]; do
    hops=$((hops + 1))
    if [ -n "${DNS_PORT:-}" ]; then
      if command -v dig >/dev/null 2>&1; then
        answer=$(dig @127.0.0.1 -p "$DNS_PORT" "$name" +short +time=5 +tries=2 2>/dev/null | head -n1 || true)
      elif command -v drill >/dev/null 2>&1; then
        answer=$(drill @127.0.0.1 -p "$DNS_PORT" "$name" 2>/dev/null | awk '/^'"$(echo "$name" | sed 's/\./\\./g')"'\./{print $5}' | head -n1 || true)
      else
        answer=$(nslookup -port="$DNS_PORT" "$name" 127.0.0.1 2>/dev/null | awk '/^Address: /{print $2}' | tail -n1 || true)
      fi
    else
      if command -v dig >/dev/null 2>&1; then
        answer=$(dig "$name" +short +time=5 +tries=2 2>/dev/null | head -n1 || true)
      elif command -v drill >/dev/null 2>&1; then
        answer=$(drill "$name" 2>/dev/null | awk '/^'"$(echo "$name" | sed 's/\./\\./g')"'\./{print $5}' | head -n1 || true)
      else
        answer=$(nslookup "$name" 2>/dev/null | awk '/^Address: /{print $2}' | tail -n1 || true)
      fi
    fi
    answer=$(printf '%s' "$answer" | sed 's/[[:space:]]//g')
    if [ -z "$answer" ]; then
      printf '%s' "$answer"
      return
    fi
    if expr "$answer" : '^[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}$' >/dev/null; then
      printf '%s' "$answer"
      return
    fi
    name="${answer%.}"
  done
}

echo "=== DNS: resolve ${fqdn} via authoritative server ==="
resolved=$(dns_query "$fqdn")
if [ "$resolved" != "127.0.0.1" ]; then
  fail "Expected A record 127.0.0.1, got: ${resolved}"
fi
pass "${fqdn} resolves to 127.0.0.1"

echo "=== TLS: connect to ALB HTTPS endpoint and verify certificate SAN ==="
if ! command -v openssl >/dev/null 2>&1; then
  fail "openssl is required for TLS verification"
fi
# Give the sim TLS proxy time to bind after CreateListener; retry because some
# simulators provision the listener asynchronously.
san=""
raw=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  raw=$(echo | openssl s_client -connect "${resolved}:${listener_port}" -servername "$fqdn" 2>&1 || true)
  san=$(printf '%s\n' "$raw" | openssl x509 -noout -ext subjectAltName 2>/dev/null | tr -d ' ' || true)
  if echo "$san" | grep -qF "DNS:${fqdn}"; then
    break
  fi
  sleep 1
done
if ! echo "$san" | grep -qF "DNS:${fqdn}"; then
  echo "DEBUG: openssl s_client raw output:" >&2
  printf '%s\n' "$raw" >&2
  fail "Expected SAN DNS:${fqdn}, got: ${san}"
fi
pass "TLS handshake served certificate with SAN DNS:${fqdn}"

echo "=== ALL ACM TLS ADVERSARIAL SLICE PROBES PASSED ==="
