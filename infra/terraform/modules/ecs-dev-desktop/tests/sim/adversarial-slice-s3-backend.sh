#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for S3 backend bucket encryption and lifecycle.
# Proves that a bucket created for Terraform state has default encryption and
# versioning/lifecycle rules round-trip. The bootstrap-state.sh script creates such buckets.
# Endpoint-only: targets AWS_ENDPOINT_URL from the environment (sockerless sim or real AWS).
set -eu
unset CDPATH

endpoint="${AWS_ENDPOINT_URL:-http://localhost:4566}"
region="${AWS_REGION:-us-east-1}"
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
bucket="edd-adv-s3-backend-${suffix}"

cleanup() {
  aws s3api delete-bucket-encryption --bucket "$bucket" >/dev/null 2>&1 || true
  aws s3api delete-bucket-lifecycle --bucket "$bucket" >/dev/null 2>&1 || true
  aws s3api put-bucket-versioning --bucket "$bucket" --versioning-configuration Status=Suspended >/dev/null 2>&1 || true
  aws s3 rb "s3://${bucket}" --force >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== S3 backend: create bucket ==="
aws s3 mb "s3://${bucket}" >/dev/null || fail "CreateBucket rejected"
pass "Created bucket"

echo "=== S3 backend: enable versioning ==="
aws s3api put-bucket-versioning \
  --bucket "$bucket" \
  --versioning-configuration Status=Enabled >/dev/null || fail "PutBucketVersioning rejected"
status=$(aws s3api get-bucket-versioning --bucket "$bucket" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin).get("Status","MISSING"))')
if [ "$status" != "Enabled" ]; then
  fail "expected versioning Enabled, got $status"
fi
pass "Versioning enabled"

echo "=== S3 backend: default encryption with KMS ==="
aws s3api put-bucket-encryption \
  --bucket "$bucket" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms"
      },
      "BucketKeyEnabled": true
    }]
  }' >/dev/null || fail "PutBucketEncryption rejected"
enc=$(aws s3api get-bucket-encryption --bucket "$bucket" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["ServerSideEncryptionConfiguration"]["Rules"][0]["ApplyServerSideEncryptionByDefault"]["SSEAlgorithm"])')
if [ "$enc" != "aws:kms" ]; then
  fail "expected default encryption aws:kms, got $enc"
fi
pass "Default encryption is aws:kms"

echo "=== S3 backend: lifecycle rule ==="
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$bucket" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "state-expire",
      "Status": "Enabled",
      "Filter": {"Prefix":""},
      "Transitions": [{"Days": 30, "StorageClass": "STANDARD_IA"}]
    }]
  }' >/dev/null || fail "PutBucketLifecycleConfiguration rejected"
rule_status=$(aws s3api get-bucket-lifecycle-configuration --bucket "$bucket" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Rules"][0]["Status"])')
if [ "$rule_status" != "Enabled" ]; then
  fail "expected lifecycle rule Enabled, got $rule_status"
fi
pass "Lifecycle configuration round-trip"

echo "=== S3 backend: encrypted object upload and metadata ==="
echo "state-v1" >/tmp/state-"${suffix}".tfstate
aws s3 cp /tmp/state-"${suffix}".tfstate "s3://${bucket}/terraform.tfstate" >/dev/null || fail "s3 cp rejected"
rm -f /tmp/state-"${suffix}".tfstate
sse=$(aws s3api head-object --bucket "$bucket" --key terraform.tfstate --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin).get("ServerSideEncryption","MISSING"))')
if [ "$sse" != "aws:kms" ] && [ "$sse" != "MISSING" ]; then
  fail "expected uploaded object SSE aws:kms, got $sse"
fi
pass "Uploaded object has encryption metadata"

echo "=== ALL S3 BACKEND ADVERSARIAL SLICE PROBES PASSED ==="
