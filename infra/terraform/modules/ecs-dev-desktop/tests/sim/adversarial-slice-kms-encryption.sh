#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for KMS encryption-in-use.
# Proves that KMS keys encrypt/decrypt data and that key-policy access control
# is enforced. The ecs-dev-desktop module uses KMS for CloudWatch Logs,
# Secrets Manager, and EBS.
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
key_id=""
user_name="edd-adv-kms-user-${suffix}"
secret_name="edd-adv-kms-secret-${suffix}"
log_group="/edd/adversarial/kms-logs-${suffix}"

# Create the IAM user early so we can reference its ARN in the key policy.
cleanup() {
  if [ -n "$key_id" ]; then
    aws kms schedule-key-deletion --key-id "$key_id" --pending-window-in-days 7 >/dev/null 2>&1 || true
  fi
  aws secretsmanager delete-secret --secret-id "$secret_name" --force-delete-without-recovery >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "$log_group" >/dev/null 2>&1 || true
  aws iam delete-access-key --user-name "$user_name" --access-key-id "$akid" >/dev/null 2>&1 || true
  aws iam delete-user --user-name "$user_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== KMS: create IAM user for access-control probe ==="
aws iam create-user --user-name "$user_name" >/dev/null || fail "CreateUser rejected"
user_arn="arn:aws:iam::123456789012:user/${user_name}"
ak_json=$(aws iam create-access-key --user-name "$user_name" --output json)
akid=$(printf '%s\n' "$ak_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["AccessKey"]["AccessKeyId"])')
secret=$(printf '%s\n' "$ak_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["AccessKey"]["SecretAccessKey"])')
if [ -z "$akid" ] || [ -z "$secret" ]; then
  fail "CreateAccessKey did not return credentials"
fi
pass "Created IAM user and access key"

echo "=== KMS: create key with user-scoped policy (Encrypt allowed, Decrypt denied) ==="
key_id=$(aws kms create-key --description "edd adversarial kms probe" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["KeyMetadata"]["KeyId"])')
key_arn=$(aws kms describe-key --key-id "$key_id" --query KeyMetadata.Arn --output text)
policy='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"'"$user_arn"'"},"Action":["kms:Encrypt","kms:GenerateDataKey"],"Resource":"'"$key_arn"'"},{"Effect":"Deny","Principal":{"AWS":"'"$user_arn"'"},"Action":"kms:Decrypt","Resource":"'"$key_arn"'"}]}'
aws kms put-key-policy --key-id "$key_id" --policy-name default --policy "$policy" >/dev/null || fail "PutKeyPolicy rejected"
pass "Key policy denies Decrypt for the test user"

echo "=== KMS: Encrypt/Decrypt round-trip as admin ==="
plaintext="hello kms"
plaintext_b64=$(printf '%s' "$plaintext" | base64)
cipher=$(aws kms encrypt --key-id "$key_id" --plaintext "$plaintext_b64" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["CiphertextBlob"])')
decrypted=$(aws kms decrypt --ciphertext-blob "$cipher" --output json |
  python3 -c 'import sys,json,base64; print(base64.b64decode(json.load(sys.stdin)["Plaintext"]).decode())')
if [ "$decrypted" != "$plaintext" ]; then
  fail "admin KMS Encrypt/Decrypt round-trip failed: expected '$plaintext', got '$decrypted'"
fi
pass "Admin Encrypt/Decrypt round-trip returns original plaintext"

echo "=== KMS: restricted user can Encrypt but is denied Decrypt ==="
restricted_endpoint="$endpoint"
restricted_region="$region"
restricted_encrypt() {
  AWS_ACCESS_KEY_ID="$akid" AWS_SECRET_ACCESS_KEY="$secret" \
    aws --endpoint-url "$restricted_endpoint" --region "$restricted_region" kms "$@"
}
restricted_cipher=$(restricted_encrypt encrypt --key-id "$key_id" --plaintext "$plaintext_b64" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["CiphertextBlob"])')
if [ -z "$restricted_cipher" ]; then
  fail "restricted user kms:Encrypt was denied or failed"
fi
pass "Restricted user can Encrypt"

if restricted_encrypt decrypt --ciphertext-blob "$restricted_cipher" --output json >/dev/null 2>&1; then
  fail "restricted user kms:Decrypt should have been denied by key policy"
fi
pass "Restricted user Decrypt denied by key policy"

echo "=== KMS: Secrets Manager create/retrieve with KMS key ==="
aws secretsmanager create-secret \
  --name "$secret_name" \
  --secret-string '{"password":"hunter2"}' \
  --kms-key-id "$key_id" >/dev/null || fail "CreateSecret rejected"
retrieved=$(aws secretsmanager get-secret-value --secret-id "$secret_name" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["SecretString"])')
if [ "$retrieved" != '{"password":"hunter2"}' ]; then
  fail "Secrets Manager retrieve returned unexpected value: $retrieved"
fi
pass "Secrets Manager secret encrypted by KMS and retrieved correctly"

echo "=== KMS: CloudWatch Logs group with kmsKeyId writes/readable events ==="
aws logs create-log-group --log-group-name "$log_group" --kms-key-id "$key_id" >/dev/null || fail "CreateLogGroup rejected"
aws logs create-log-stream --log-group-name "$log_group" --log-stream-name "stream-${suffix}" >/dev/null || fail "CreateLogStream rejected"
timestamp=$(python3 -c 'import time; print(int(time.time()*1000))')
aws logs put-log-events \
  --log-group-name "$log_group" \
  --log-stream-name "stream-${suffix}" \
  --log-events "timestamp=${timestamp},message=kms-encrypted-event" >/dev/null || fail "PutLogEvents rejected"
log_messages=$(aws logs get-log-events --log-group-name "$log_group" --log-stream-name "stream-${suffix}" --output json |
  python3 -c 'import sys,json; print([e["message"] for e in json.load(sys.stdin).get("events",[])])')
if ! echo "$log_messages" | grep -q "kms-encrypted-event"; then
  fail "KMS-encrypted CloudWatch Logs event not readable: $log_messages"
fi
pass "CloudWatch Logs group with kmsKeyId round-trips events"

echo "=== ALL KMS ENCRYPTION ADVERSARIAL SLICE PROBES PASSED ==="
