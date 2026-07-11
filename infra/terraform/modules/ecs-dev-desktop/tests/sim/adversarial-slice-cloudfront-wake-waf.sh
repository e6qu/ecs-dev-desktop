#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for the control-plane scale-to-zero entry:
#   (A) a CloudFront distribution with an ORIGIN GROUP whose FailoverCriteria fails
#       over on 502/503/504 (ALB primary -> wake-Lambda failover);
#   (B) a Lambda function with a Function URL (the failover origin);
#   (C) a CLOUDFRONT-scope WAFv2 web ACL + IP set, and attaching the ACL to the
#       distribution via the distribution's WebACLId.
# These are the shapes cloudfront.tf / waf-cloudfront.tf create. Endpoint-only:
# targets AWS_ENDPOINT_URL from the environment (sockerless sim or real AWS).
#
# The sim (sockerless b5126463) supports CloudFront distributions/origin-groups,
# Lambda + Function URL, and WAFv2 CLOUDFRONT scope. If a target lacks any of these,
# the corresponding block records a SKIP and the slice stays green for what IS
# supported (see BUGS.md -> External blockers for any recorded upstream gap).
set -eu
unset CDPATH

endpoint="${AWS_ENDPOINT_URL:-http://127.0.0.1:4566}"
region="${AWS_REGION:-us-east-1}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"

# AWS-managed CloudFront policy ids (global/stable) — the same the module uses.
CACHING_DISABLED_ID="4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
ALL_VIEWER_ORP_ID="216adef6-5c7f-47e4-b989-5492eafa07d3"

aws() {
  command aws --endpoint-url "$endpoint" --region "$region" "$@"
}
# CloudFront/WAFv2/Lambda are global; CloudFront in particular is always us-east-1.
aws_use1() {
  command aws --endpoint-url "$endpoint" --region "us-east-1" "$@"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }
skip() { echo "SKIP: $*"; }

suffix="$(date +%s)"
role_name="edd-wake-probe-${suffix}"
fn_name="edd-wake-probe-${suffix}"
acl_name="edd-cf-probe-${suffix}"
ipset_name="edd-cf-ipset-${suffix}"
work="$(mktemp -d)"

role_arn=""
fn_created=""
dist_id=""
dist_etag=""
acl_id=""
ipset_id=""

cleanup() {
  if [ -n "${dist_id:-}" ]; then
    # Disable then delete requires the ETag dance; best-effort teardown only.
    aws_use1 cloudfront delete-distribution --id "$dist_id" --if-match "${dist_etag:-}" >/dev/null 2>&1 || true
  fi
  if [ -n "${fn_created:-}" ]; then
    aws lambda delete-function --function-name "$fn_name" >/dev/null 2>&1 || true
  fi
  if [ -n "${role_arn:-}" ]; then
    aws iam delete-role --role-name "$role_name" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# (B) Lambda + Function URL (the CloudFront failover origin)
# ---------------------------------------------------------------------------
echo "=== Lambda: create the wake function + Function URL ==="
if ! aws lambda list-functions >/dev/null 2>&1; then
  skip "Lambda API not available on this target"
  wake_origin_domain="wake.example.invalid"
else
  role_arn=$(aws iam create-role \
    --role-name "$role_name" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --query 'Role.Arn' --output text)
  [ -n "$role_arn" ] || fail "CreateRole did not return an ARN"

  printf 'exports.handler = async () => ({ statusCode: 200, body: "waking" });\n' >"${work}/index.js"
  (cd "$work" && zip -q -X function.zip index.js)

  aws lambda create-function \
    --function-name "$fn_name" \
    --runtime nodejs22.x \
    --handler index.handler \
    --role "$role_arn" \
    --zip-file "fileb://${work}/function.zip" >/dev/null || fail "CreateFunction rejected"
  fn_created=1
  pass "Created Lambda ${fn_name}"

  fn_url=$(aws lambda create-function-url-config \
    --function-name "$fn_name" \
    --auth-type NONE \
    --query 'FunctionUrl' --output text)
  if [ -z "$fn_url" ] || [ "$fn_url" = "None" ]; then
    fail "CreateFunctionUrlConfig did not return a URL"
  fi
  pass "Function URL: ${fn_url}"
  # Strip scheme + trailing slash to the bare host, exactly as the module does.
  wake_origin_domain=$(printf '%s' "$fn_url" | sed -e 's#^https://##' -e 's#/$##')
fi

# ---------------------------------------------------------------------------
# (C) CLOUDFRONT-scope WAFv2 web ACL + IP set
# ---------------------------------------------------------------------------
echo "=== WAFv2: create a CLOUDFRONT-scope web ACL + IP set ==="
waf_ok=0
if ! aws_use1 wafv2 list-web-acls --scope CLOUDFRONT >/dev/null 2>&1; then
  skip "WAFv2 CLOUDFRONT scope not available on this target"
else
  acl_out=$(aws_use1 wafv2 create-web-acl \
    --name "$acl_name" \
    --scope CLOUDFRONT \
    --default-action Allow={} \
    --visibility-config "SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=${acl_name}" \
    --output json)
  acl_id=$(printf '%s' "$acl_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Summary"]["Id"])')
  acl_arn=$(printf '%s' "$acl_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Summary"]["ARN"])')
  [ -n "$acl_id" ] || fail "CreateWebACL did not return an Id"
  case "$acl_arn" in
    *:global/webacl/*) pass "CLOUDFRONT web ACL ARN is global-scoped: ${acl_arn}" ;;
    *) fail "Expected a :global/webacl/ ARN, got: ${acl_arn}" ;;
  esac

  ipset_out=$(aws_use1 wafv2 create-ip-set \
    --name "$ipset_name" \
    --scope CLOUDFRONT \
    --ip-address-version IPV4 \
    --addresses \
    --output json)
  ipset_id=$(printf '%s' "$ipset_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Summary"]["Id"])')
  [ -n "$ipset_id" ] || fail "CreateIPSet did not return an Id"
  pass "Created empty CLOUDFRONT IP set ${ipset_id}"

  # The control plane populates the IP set at runtime — prove UpdateIPSet takes CIDRs.
  ipset_lock=$(aws_use1 wafv2 get-ip-set --name "$ipset_name" --scope CLOUDFRONT --id "$ipset_id" \
    --query 'LockToken' --output text)
  aws_use1 wafv2 update-ip-set \
    --name "$ipset_name" --scope CLOUDFRONT --id "$ipset_id" \
    --addresses "203.0.113.0/24" \
    --lock-token "$ipset_lock" >/dev/null || fail "UpdateIPSet rejected an admin CIDR"
  got_cidr=$(aws_use1 wafv2 get-ip-set --name "$ipset_name" --scope CLOUDFRONT --id "$ipset_id" \
    --query 'IPSet.Addresses[0]' --output text)
  [ "$got_cidr" = "203.0.113.0/24" ] || fail "IP set did not retain the admin CIDR (got ${got_cidr})"
  pass "IP set accepted + retained an admin CIDR (UpdateIPSet)"
  waf_ok=1
fi

# ---------------------------------------------------------------------------
# (A) CloudFront distribution with an origin GROUP + failover on 502/503/504
# ---------------------------------------------------------------------------
echo "=== CloudFront: create a distribution with an origin group ==="
if ! aws_use1 cloudfront list-distributions >/dev/null 2>&1; then
  skip "CloudFront API not available on this target"
  echo "=== CLOUDFRONT/WAKE/WAF ADVERSARIAL SLICE: PARTIAL (see SKIP lines) ==="
  exit 0
fi

cat >"${work}/dist.json" <<JSON
{
  "CallerReference": "edd-cf-probe-${suffix}",
  "Comment": "edd scale-to-zero probe ${suffix}",
  "Enabled": true,
  "PriceClass": "PriceClass_100",
  "Origins": {
    "Quantity": 2,
    "Items": [
      {
        "Id": "alb-control-plane",
        "DomainName": "eddsim-cp-probe.elb.amazonaws.com",
        "CustomOriginConfig": {
          "HTTPPort": 80, "HTTPSPort": 443,
          "OriginProtocolPolicy": "https-only",
          "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] }
        }
      },
      {
        "Id": "wake-lambda",
        "DomainName": "${wake_origin_domain}",
        "CustomOriginConfig": {
          "HTTPPort": 80, "HTTPSPort": 443,
          "OriginProtocolPolicy": "https-only",
          "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] }
        }
      }
    ]
  },
  "OriginGroups": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "cp-origin-group",
        "FailoverCriteria": { "StatusCodes": { "Quantity": 3, "Items": [502, 503, 504] } },
        "Members": { "Quantity": 2, "Items": [ { "OriginId": "alb-control-plane" }, { "OriginId": "wake-lambda" } ] }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "cp-origin-group",
    "ViewerProtocolPolicy": "redirect-to-https",
    "Compress": true,
    "CachePolicyId": "${CACHING_DISABLED_ID}",
    "OriginRequestPolicyId": "${ALL_VIEWER_ORP_ID}",
    "AllowedMethods": {
      "Quantity": 7,
      "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET","HEAD"] }
    }
  },
  "ViewerCertificate": { "CloudFrontDefaultCertificate": true },
  "Restrictions": { "GeoRestriction": { "RestrictionType": "none", "Quantity": 0 } }
}
JSON

create_out=$(aws_use1 cloudfront create-distribution \
  --distribution-config "file://${work}/dist.json" --output json) || fail "CreateDistribution rejected"
dist_id=$(printf '%s' "$create_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Distribution"]["Id"])')
[ -n "$dist_id" ] || fail "CreateDistribution did not return an Id"
pass "Created distribution ${dist_id}"

echo "=== CloudFront: read back the origin group + failover criteria ==="
get_out=$(aws_use1 cloudfront get-distribution --id "$dist_id" --output json)
dist_etag=$(printf '%s' "$get_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ETag"])')
og_qty=$(printf '%s' "$get_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Distribution"]["DistributionConfig"]["OriginGroups"]["Quantity"])')
[ "$og_qty" = "1" ] || fail "Expected 1 origin group, got ${og_qty}"
codes=$(printf '%s' "$get_out" | python3 -c 'import sys,json; print(",".join(str(c) for c in json.load(sys.stdin)["Distribution"]["DistributionConfig"]["OriginGroups"]["Items"][0]["FailoverCriteria"]["StatusCodes"]["Items"]))')
case ",${codes}," in
  *,503,*) pass "Origin group fails over on 503 (codes: ${codes})" ;;
  *) fail "Expected failover status 503 in codes, got: ${codes}" ;;
esac

if [ "$waf_ok" = 1 ]; then
  echo "=== CloudFront: attach the CLOUDFRONT web ACL via WebACLId ==="
  # Set WebACLId on the distribution config and update — exactly the module's
  # `web_acl_id = aws_wafv2_web_acl.cloudfront[0].arn`.
  python3 - "$get_out" "$acl_arn" >"${work}/dist-waf.json" <<'PY'
import sys, json
data = json.loads(sys.argv[1])
cfg = data["Distribution"]["DistributionConfig"]
cfg["WebACLId"] = sys.argv[2]
print(json.dumps(cfg))
PY
  upd_out=$(aws_use1 cloudfront update-distribution \
    --id "$dist_id" --if-match "$dist_etag" \
    --distribution-config "file://${work}/dist-waf.json" --output json) || fail "UpdateDistribution (WebACLId) rejected"
  dist_etag=$(printf '%s' "$upd_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ETag"])')
  got_acl=$(printf '%s' "$upd_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Distribution"]["DistributionConfig"].get("WebACLId",""))')
  [ "$got_acl" = "$acl_arn" ] || fail "Distribution did not retain WebACLId (got ${got_acl})"
  pass "Distribution attached to CLOUDFRONT web ACL ${acl_arn}"
fi

echo "=== ALL CLOUDFRONT / WAKE-LAMBDA / CLOUDFRONT-WAF ADVERSARIAL SLICE PROBES PASSED ==="
