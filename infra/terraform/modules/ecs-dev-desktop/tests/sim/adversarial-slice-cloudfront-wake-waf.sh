#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for the control-plane scale-to-zero entry:
#   (A) a CloudFront distribution with an ORIGIN GROUP whose FailoverCriteria fails
#       over on 502/503/504 (ALB primary -> wake-Lambda failover);
#   (B) a Lambda function with a Function URL (the failover origin);
#   (C) a CLOUDFRONT-scope WAFv2 web ACL + IP set, and attaching the ACL to the
#       distribution via the distribution's WebACLId.
# Plus the DoS/cost-amplification hardening (harden/scale-to-zero-security):
#   - the Function URL is AWS_IAM (not publicly invokable), fronted by a lambda-type
#     Origin Access Control that SigV4-signs CloudFront's origin requests, and a
#     CloudFront-scoped lambda:InvokeFunctionUrl grant;
#   - the wake Lambda carries a bounded reserved-concurrency ceiling;
#   - the CLOUDFRONT WAF seeds a per-IP rate_based_statement BLOCK rule (limit 2000)
#     alongside the managed common rule set — evaluated at the edge on the VIEWER
#     request, BEFORE origin-group failover, so a blocked flood never invokes the wake
#     Lambda (no per-invoke/GB-s cost, no ECS-API pressure).
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
oac_id=""

cleanup() {
  if [ -n "${dist_id:-}" ]; then
    # Disable then delete requires the ETag dance; best-effort teardown only.
    aws_use1 cloudfront delete-distribution --id "$dist_id" --if-match "${dist_etag:-}" >/dev/null 2>&1 || true
  fi
  if [ -n "${oac_id:-}" ]; then
    oac_etag=$(aws_use1 cloudfront get-origin-access-control --id "$oac_id" --query 'ETag' --output text 2>/dev/null || true)
    aws_use1 cloudfront delete-origin-access-control --id "$oac_id" --if-match "${oac_etag:-}" >/dev/null 2>&1 || true
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

  # AWS_IAM (not NONE): the module locks the Function URL to IAM so only CloudFront —
  # via OAC SigV4 signing + a scoped invoke permission — can reach it, keeping the
  # wake path behind CloudFront + the CLOUDFRONT WAF.
  fn_url=$(aws lambda create-function-url-config \
    --function-name "$fn_name" \
    --auth-type AWS_IAM \
    --query 'FunctionUrl' --output text)
  if [ -z "$fn_url" ] || [ "$fn_url" = "None" ]; then
    fail "CreateFunctionUrlConfig did not return a URL"
  fi
  # (b) The Function URL must NOT be publicly invokable: AWS_IAM means every caller
  # must present SigV4 creds. Combined with the scoped CloudFront InvokeFunctionUrl
  # grant added after the distribution exists, only CloudFront (post-WAF) can invoke
  # it — closing the direct-invoke cost hole that auth NONE would open.
  got_auth=$(aws lambda get-function-url-config --function-name "$fn_name" \
    --query 'AuthType' --output text)
  [ "$got_auth" = "AWS_IAM" ] || fail "Function URL auth type is ${got_auth}, expected AWS_IAM (auth NONE is a direct-invoke cost hole)"
  pass "Function URL is AWS_IAM (not publicly invokable): ${fn_url}"

  # (a) Bound the wake Lambda's concurrency so a CloudFront-failover flood can't fan
  # out into unbounded concurrent invocations (billed per-invoke + GB-s) or hammer the
  # ECS DescribeServices/UpdateService APIs. Prove the reserved-concurrency ceiling
  # sticks — the module sets var.wake_lambda_reserved_concurrency (default 5).
  wake_reserved=5
  aws lambda put-function-concurrency \
    --function-name "$fn_name" \
    --reserved-concurrent-executions "$wake_reserved" >/dev/null ||
    fail "PutFunctionConcurrency rejected the reserved-concurrency ceiling"
  got_reserved=$(aws lambda get-function-concurrency --function-name "$fn_name" \
    --query 'ReservedConcurrentExecutions' --output text)
  [ "$got_reserved" = "$wake_reserved" ] ||
    fail "Reserved concurrency did not round-trip (got ${got_reserved}, expected ${wake_reserved})"
  pass "Wake Lambda reserved concurrency bounded at ${wake_reserved} (cost + ECS-API ceiling)"
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
  # Seed the SAME baseline rule band the module creates: the AWS common managed rule
  # set at priority 0 and a per-IP rate-based BLOCK rule at priority 1. The managed
  # common rule set is signature filtering only — the rate-based rule is the dedicated
  # volumetric guard that caps L7 floods + wake-amplification at the edge.
  cat >"${work}/waf-rules.json" <<'JSON'
[
  {
    "Name": "aws-common-rule-set",
    "Priority": 0,
    "OverrideAction": { "None": {} },
    "Statement": { "ManagedRuleGroupStatement": { "VendorName": "AWS", "Name": "AWSManagedRulesCommonRuleSet" } },
    "VisibilityConfig": { "SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "edd-probe-common" }
  },
  {
    "Name": "rate-limit-per-ip",
    "Priority": 1,
    "Action": { "Block": {} },
    "Statement": { "RateBasedStatement": { "Limit": 2000, "AggregateKeyType": "IP" } },
    "VisibilityConfig": { "SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "edd-probe-rate-limit" }
  }
]
JSON
  acl_out=$(aws_use1 wafv2 create-web-acl \
    --name "$acl_name" \
    --scope CLOUDFRONT \
    --default-action Allow={} \
    --rules "file://${work}/waf-rules.json" \
    --visibility-config "SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=${acl_name}" \
    --output json)
  acl_id=$(printf '%s' "$acl_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Summary"]["Id"])')
  acl_arn=$(printf '%s' "$acl_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Summary"]["ARN"])')
  [ -n "$acl_id" ] || fail "CreateWebACL did not return an Id"
  case "$acl_arn" in
    *:global/webacl/*) pass "CLOUDFRONT web ACL ARN is global-scoped: ${acl_arn}" ;;
    *) fail "Expected a :global/webacl/ ARN, got: ${acl_arn}" ;;
  esac

  # Prove the rate-based BLOCK rule round-trips with its limit intact.
  rate_limit=$(aws_use1 wafv2 get-web-acl --name "$acl_name" --scope CLOUDFRONT --id "$acl_id" \
    --query "WebACL.Rules[?Name=='rate-limit-per-ip'].Statement.RateBasedStatement.Limit | [0]" \
    --output text)
  [ "$rate_limit" = "2000" ] || fail "Rate-based rule limit did not round-trip (got ${rate_limit})"
  rate_action=$(aws_use1 wafv2 get-web-acl --name "$acl_name" --scope CLOUDFRONT --id "$acl_id" \
    --query "WebACL.Rules[?Name=='rate-limit-per-ip'].Action.Block | [0]" --output json)
  [ "$rate_action" != "null" ] || fail "Rate-based rule is not a Block action"
  pass "CLOUDFRONT web ACL seeds common rule set + per-IP rate-based BLOCK (limit 2000)"

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

# Origin Access Control for the wake origin: CloudFront SigV4-signs origin requests to
# the AWS_IAM Function URL so it accepts them (origin_type "lambda", signing always).
oac_id=$(aws_use1 cloudfront create-origin-access-control \
  --origin-access-control-config "Name=edd-wake-oac-${suffix},Description=edd wake OAC probe,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=lambda" \
  --query 'OriginAccessControl.Id' --output text)
if [ -z "$oac_id" ] || [ "$oac_id" = "None" ]; then
  fail "CreateOriginAccessControl (lambda) did not return an Id"
fi
got_oac_type=$(aws_use1 cloudfront get-origin-access-control --id "$oac_id" \
  --query 'OriginAccessControl.OriginAccessControlConfig.OriginAccessControlOriginType' --output text)
[ "$got_oac_type" = "lambda" ] || fail "OAC origin type is ${got_oac_type}, expected lambda"
pass "Created lambda-type OAC ${oac_id} (sigv4, signing always)"

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
        "OriginAccessControlId": "${oac_id}",
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
dist_arn=$(printf '%s' "$create_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Distribution"]["ARN"])')
[ -n "$dist_id" ] || fail "CreateDistribution did not return an Id"
pass "Created distribution ${dist_id}"

echo "=== CloudFront: read back the wake origin's OAC binding ==="
got_origin_oac=$(aws_use1 cloudfront get-distribution --id "$dist_id" \
  --query "Distribution.DistributionConfig.Origins.Items[?Id=='wake-lambda'].OriginAccessControlId | [0]" \
  --output text)
[ "$got_origin_oac" = "$oac_id" ] || fail "wake origin OAC id is ${got_origin_oac}, expected ${oac_id}"
pass "Wake origin is bound to the lambda OAC ${oac_id} (CloudFront signs origin requests)"

# The module grants ONLY the CloudFront service principal, scoped to THIS distribution,
# lambda:InvokeFunctionUrl — so only CloudFront (after WAF) can invoke the AWS_IAM URL.
if [ -n "${fn_created:-}" ] && [ -n "${dist_arn:-}" ]; then
  echo "=== Lambda: grant CloudFront (scoped to this distribution) InvokeFunctionUrl ==="
  aws lambda add-permission \
    --function-name "$fn_name" \
    --statement-id AllowCloudFrontInvokeFunctionUrl \
    --action lambda:InvokeFunctionUrl \
    --principal cloudfront.amazonaws.com \
    --source-arn "$dist_arn" \
    --function-url-auth-type AWS_IAM >/dev/null || fail "AddPermission (CloudFront InvokeFunctionUrl) rejected"
  got_policy=$(aws lambda get-policy --function-name "$fn_name" --query 'Policy' --output text)
  case "$got_policy" in
    *cloudfront.amazonaws.com*InvokeFunctionUrl* | *InvokeFunctionUrl*cloudfront.amazonaws.com*)
      pass "Resource policy allows cloudfront.amazonaws.com lambda:InvokeFunctionUrl scoped to the distribution"
      ;;
    *) fail "Function policy missing the scoped CloudFront InvokeFunctionUrl grant" ;;
  esac
fi

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
