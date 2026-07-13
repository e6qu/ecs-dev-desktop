#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for the control-plane scale-to-zero entry, matching the
# CURRENT design (single ALB origin + a 503 custom_error_response -> a wake Lambda fronted by API
# Gateway, gated by a CloudFront shared-secret header). These are the shapes cloudfront.tf /
# waf-cloudfront.tf create:
#   (A) a wake Lambda fronted by an API Gateway HTTP API (AWS_PROXY integration, payload format 2.0,
#       $default route + $default auto-deploy stage) — NOT a Lambda Function URL. Function URLs are
#       non-functional in the edd-prod account (403 at the URL front door, zero invocations, both auth
#       modes; direct SDK invoke works — see BUGS.md), so the wake origin is an API Gateway host.
#   (B) a CLOUDFRONT-scope WAFv2 web ACL + IP set (common managed rule set + a per-IP rate-based BLOCK
#       rule), attached to the distribution via WebACLId.
#   (C) a CloudFront distribution with a SINGLE ALB origin (all methods — the app POSTs to page paths
#       via Next.js Server Actions, and CloudFront forbids write methods on an origin-group behaviour,
#       so there is NO origin group), a `/_edd_wake*` ordered behaviour targeting the API Gateway wake
#       origin, a 503 `custom_error_response` (response_code 200) routing a scaled-to-zero ALB 503 to
#       `/_edd_wake`, and the wake origin carrying an `x-edd-wake-token` custom origin header.
# Scale-to-zero access control + DoS/cost hardening:
#   - the wake path is gated by the `x-edd-wake-token` shared secret ONLY CloudFront injects (the
#     handler rejects any request lacking it before any ECS call), so a direct hit on the public API
#     can't wake the service — and even if it did, the only effect is an idempotent ecs:UpdateService;
#   - the CLOUDFRONT WAF seeds a per-IP rate_based_statement BLOCK rule (limit 2000) alongside the
#     managed common rule set — evaluated at the edge on the VIEWER request, so a blocked flood never
#     reaches the wake origin (no per-invoke/GB-s cost, no ECS-API pressure).
# Endpoint-only: targets AWS_ENDPOINT_URL from the environment (sockerless sim or real AWS).
#
# The sim (sockerless) supports API Gateway v2 (HTTP APIs), CloudFront distributions with
# custom-header origins + custom_error_responses, and WAFv2 CLOUDFRONT scope. If a target lacks any of
# these, the corresponding block records a SKIP and the slice stays green for what IS supported (see
# BUGS.md -> External blockers for any recorded upstream gap). If a supported shape behaves DIFFERENTLY
# from real AWS, that is a simulator bug: file it on github.com/e6qu/sockerless and reference it here.
set -eu
unset CDPATH

endpoint="${AWS_ENDPOINT_URL:-http://127.0.0.1:4566}"
region="${AWS_REGION:-us-east-1}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"

# AWS-managed CloudFront policy ids (global/stable) — the same the module uses.
CACHING_DISABLED_ID="4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
ALL_VIEWER_ORP_ID="216adef6-5c7f-47e4-b989-5492eafa07d3"
# AllViewerExceptHostHeader: the wake behaviour's ORP, so CloudFront sends the API Gateway's own Host
# (not the viewer host, which would fail to match the API), while still forwarding x-edd-wake-token.
ALL_VIEWER_EXCEPT_HOST_ORP_ID="b689b0a8-53d0-40ab-baf2-68738e2966ac"
# The shared-secret header CloudFront injects on wake-origin requests (module local.wake_token_header).
WAKE_TOKEN_HEADER="x-edd-wake-token"
# The dedicated path the wake origin serves + the 503 custom_error_response points at.
WAKE_PATH="/_edd_wake"

aws() {
  command aws --endpoint-url "$endpoint" --region "$region" "$@"
}
# CloudFront/WAFv2 are global; CloudFront in particular is always us-east-1.
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
api_name="edd-wake-probe-${suffix}"
acl_name="edd-cf-probe-${suffix}"
ipset_name="edd-cf-ipset-${suffix}"
work="$(mktemp -d)"

role_arn=""
fn_created=""
api_id=""
dist_id=""
dist_etag=""
acl_id=""
ipset_id=""

cleanup() {
  if [ -n "${dist_id:-}" ]; then
    # Disable then delete requires the ETag dance; best-effort teardown only.
    aws_use1 cloudfront delete-distribution --id "$dist_id" --if-match "${dist_etag:-}" >/dev/null 2>&1 || true
  fi
  if [ -n "${api_id:-}" ]; then
    aws apigatewayv2 delete-api --api-id "$api_id" >/dev/null 2>&1 || true
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
# (A) Wake Lambda fronted by an API Gateway HTTP API (the CloudFront wake origin)
# ---------------------------------------------------------------------------
echo "=== Lambda + API Gateway: create the wake function behind an HTTP API ==="
wake_origin_domain="wake.example.invalid"
if ! aws lambda list-functions >/dev/null 2>&1; then
  skip "Lambda API not available on this target"
elif ! aws apigatewayv2 get-apis >/dev/null 2>&1; then
  skip "API Gateway v2 API not available on this target"
else
  role_arn=$(aws iam create-role \
    --role-name "$role_name" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --query 'Role.Arn' --output text)
  [ -n "$role_arn" ] || fail "CreateRole did not return an ARN"

  printf 'exports.handler = async () => ({ statusCode: 200, body: "waking" });\n' >"${work}/index.js"
  (cd "$work" && zip -q -X function.zip index.js)

  fn_arn=$(aws lambda create-function \
    --function-name "$fn_name" \
    --runtime nodejs22.x \
    --handler index.handler \
    --role "$role_arn" \
    --zip-file "fileb://${work}/function.zip" \
    --query 'FunctionArn' --output text) || fail "CreateFunction rejected"
  fn_created=1
  [ -n "$fn_arn" ] && [ "$fn_arn" != "None" ] || fail "CreateFunction did not return an ARN"
  pass "Created wake Lambda ${fn_name}"

  # The wake front door is an HTTP API with an AWS_PROXY integration on payload format 2.0 — the SAME
  # event shape a Function URL delivers, so the handler is identical. NOT a Function URL.
  api_out=$(aws apigatewayv2 create-api \
    --name "$api_name" --protocol-type HTTP --output json) || fail "CreateApi (HTTP) rejected"
  api_id=$(printf '%s' "$api_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ApiId"])')
  api_endpoint=$(printf '%s' "$api_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ApiEndpoint"])')
  [ -n "$api_id" ] || fail "CreateApi did not return an ApiId"
  case "$api_endpoint" in
    https://*.execute-api.*.amazonaws.com) pass "Created HTTP API ${api_id} (${api_endpoint})" ;;
    *) fail "Unexpected API endpoint shape: ${api_endpoint}" ;;
  esac

  int_id=$(aws apigatewayv2 create-integration \
    --api-id "$api_id" \
    --integration-type AWS_PROXY \
    --integration-uri "$fn_arn" \
    --payload-format-version 2.0 \
    --query 'IntegrationId' --output text) || fail "CreateIntegration (AWS_PROXY) rejected"
  [ -n "$int_id" ] && [ "$int_id" != "None" ] || fail "CreateIntegration did not return an IntegrationId"
  # The payload format version must round-trip as 2.0 (Function-URL-identical event shape).
  got_pfv=$(aws apigatewayv2 get-integration --api-id "$api_id" --integration-id "$int_id" \
    --query 'PayloadFormatVersion' --output text)
  [ "$got_pfv" = "2.0" ] || fail "Integration payload format is ${got_pfv}, expected 2.0"
  pass "AWS_PROXY integration on payload format 2.0 (Function-URL-identical event)"

  # A single $default route covers every wake request: CloudFront only ever sends /_edd_wake* here and
  # the handler ignores the path.
  aws apigatewayv2 create-route \
    --api-id "$api_id" --route-key "\$default" --target "integrations/${int_id}" >/dev/null ||
    fail "CreateRoute (\$default) rejected"
  got_route=$(aws apigatewayv2 get-routes --api-id "$api_id" \
    --query "Items[?RouteKey=='\$default'].RouteKey | [0]" --output text)
  [ "$got_route" = "\$default" ] || fail "\$default route did not round-trip (got ${got_route})"
  pass "\$default route targets the wake integration"

  # $default stage with auto-deploy: served at the bare execute-api host (no stage path segment).
  aws apigatewayv2 create-stage \
    --api-id "$api_id" --stage-name "\$default" --auto-deploy >/dev/null ||
    fail "CreateStage (\$default, auto-deploy) rejected"
  got_stage=$(aws apigatewayv2 get-stage --api-id "$api_id" --stage-name "\$default" \
    --query 'StageName' --output text)
  [ "$got_stage" = "\$default" ] || fail "\$default stage did not round-trip (got ${got_stage})"
  pass "\$default auto-deploy stage created"

  # Standard AWS_PROXY invoke grant, scoped to THIS API's execution ARN (not a Function-URL grant).
  api_exec_arn="arn:aws:execute-api:${region}:000000000000:${api_id}"
  aws lambda add-permission \
    --function-name "$fn_name" \
    --statement-id AllowApiGatewayInvoke \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "${api_exec_arn}/*/*" >/dev/null || fail "AddPermission (API Gateway invoke) rejected"
  got_policy=$(aws lambda get-policy --function-name "$fn_name" --query 'Policy' --output text)
  case "$got_policy" in
    *apigateway.amazonaws.com*InvokeFunction* | *InvokeFunction*apigateway.amazonaws.com*)
      pass "Resource policy allows apigateway.amazonaws.com lambda:InvokeFunction scoped to the API"
      ;;
    *) fail "Function policy missing the scoped API Gateway invoke grant" ;;
  esac

  # The wake origin CloudFront reaches is the API's bare execute-api host (no scheme, no path).
  wake_origin_domain=$(printf '%s' "$api_endpoint" | sed -e 's#^https://##' -e 's#/$##')
fi

# ---------------------------------------------------------------------------
# (B) CLOUDFRONT-scope WAFv2 web ACL + IP set
# ---------------------------------------------------------------------------
echo "=== WAFv2: create a CLOUDFRONT-scope web ACL + IP set ==="
waf_ok=0
if ! aws_use1 wafv2 list-web-acls --scope CLOUDFRONT >/dev/null 2>&1; then
  skip "WAFv2 CLOUDFRONT scope not available on this target"
else
  # Seed the SAME baseline rule band the module creates: the AWS common managed rule set at priority 0
  # and a per-IP rate-based BLOCK rule at priority 1. The managed common rule set is signature
  # filtering only — the rate-based rule is the dedicated volumetric guard that caps L7 floods +
  # wake-amplification at the edge.
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
# (C) CloudFront distribution: single ALB origin + a 503 custom_error_response -> the wake origin
# ---------------------------------------------------------------------------
echo "=== CloudFront: create a distribution with a single ALB origin + a wake behaviour ==="
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
        "CustomHeaders": {
          "Quantity": 1,
          "Items": [ { "HeaderName": "${WAKE_TOKEN_HEADER}", "HeaderValue": "probe-shared-secret-${suffix}" } ]
        },
        "CustomOriginConfig": {
          "HTTPPort": 80, "HTTPSPort": 443,
          "OriginProtocolPolicy": "https-only",
          "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] }
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "alb-control-plane",
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
  "CacheBehaviors": {
    "Quantity": 1,
    "Items": [
      {
        "PathPattern": "${WAKE_PATH}*",
        "TargetOriginId": "wake-lambda",
        "ViewerProtocolPolicy": "redirect-to-https",
        "Compress": true,
        "CachePolicyId": "${CACHING_DISABLED_ID}",
        "OriginRequestPolicyId": "${ALL_VIEWER_EXCEPT_HOST_ORP_ID}",
        "AllowedMethods": {
          "Quantity": 3,
          "Items": ["GET","HEAD","OPTIONS"],
          "CachedMethods": { "Quantity": 2, "Items": ["GET","HEAD"] }
        }
      }
    ]
  },
  "CustomErrorResponses": {
    "Quantity": 1,
    "Items": [
      { "ErrorCode": 503, "ResponsePagePath": "${WAKE_PATH}", "ResponseCode": "200", "ErrorCachingMinTTL": 0 }
    ]
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

get_out=$(aws_use1 cloudfront get-distribution --id "$dist_id" --output json)
dist_etag=$(printf '%s' "$get_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ETag"])')

echo "=== CloudFront: prove there is NO origin group (single-origin design) ==="
og_qty=$(printf '%s' "$get_out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Distribution"]["DistributionConfig"]["OriginGroups"]["Quantity"])')
[ "$og_qty" = "0" ] || fail "Expected 0 origin groups (single ALB origin), got ${og_qty}"
pass "No origin group — default behaviour is the single ALB origin (all methods pass through)"

echo "=== CloudFront: prove the 503 custom_error_response routes to the wake path ==="
cer=$(printf '%s' "$get_out" | python3 -c '
import sys, json
items = json.load(sys.stdin)["Distribution"]["DistributionConfig"]["CustomErrorResponses"]["Items"]
m = [i for i in items if i["ErrorCode"] == 503]
print((m[0]["ResponsePagePath"] + "," + str(m[0]["ResponseCode"])) if m else "none")
')
[ "$cer" = "${WAKE_PATH},200" ] || fail "503 custom_error_response is '${cer}', expected '${WAKE_PATH},200'"
pass "503 custom_error_response -> ${WAKE_PATH} (response_code 200) — a scaled-to-zero ALB 503 serves the wake page"

echo "=== CloudFront: prove the wake behaviour targets the wake origin ==="
beh_target=$(printf '%s' "$get_out" | python3 -c '
import sys, json
items = json.load(sys.stdin)["Distribution"]["DistributionConfig"]["CacheBehaviors"]["Items"]
m = [b for b in items if b["PathPattern"].startswith("/_edd_wake")]
print(m[0]["TargetOriginId"] if m else "none")
')
[ "$beh_target" = "wake-lambda" ] || fail "wake behaviour targets '${beh_target}', expected 'wake-lambda'"
pass "${WAKE_PATH}* behaviour targets the API Gateway wake origin"

echo "=== CloudFront: prove the wake origin carries the shared-secret custom header ==="
got_hdr=$(printf '%s' "$get_out" | python3 -c '
import sys, json
o = [o for o in json.load(sys.stdin)["Distribution"]["DistributionConfig"]["Origins"]["Items"] if o["Id"] == "wake-lambda"][0]
hs = o.get("CustomHeaders", {}).get("Items", [])
print(next((h["HeaderName"] for h in hs), "none"))
')
[ "$got_hdr" = "$WAKE_TOKEN_HEADER" ] || fail "wake origin custom header is '${got_hdr}', expected '${WAKE_TOKEN_HEADER}'"
pass "Wake origin injects the ${WAKE_TOKEN_HEADER} shared-secret header (CloudFront-only access control)"

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

# Keep dist_arn referenced (teardown + parity with the module's distribution-scoped grants).
[ -n "${dist_arn:-}" ] && : "${dist_arn}"

echo "=== ALL CLOUDFRONT / WAKE-API-GATEWAY / CLOUDFRONT-WAF ADVERSARIAL SLICE PROBES PASSED ==="
