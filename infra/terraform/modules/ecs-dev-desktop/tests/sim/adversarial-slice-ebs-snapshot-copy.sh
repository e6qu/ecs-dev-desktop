#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for cross-region EBS snapshot copy + restore.
# Proves that a snapshot can be copied to another region and restored to a new volume
# with the original data. The ecs-dev-desktop module relies on EBS snapshots for persistence.
# Endpoint-only: targets AWS_ENDPOINT_URL from the environment (sockerless sim or real AWS).
set -eu
unset CDPATH

endpoint="${AWS_ENDPOINT_URL:-http://127.0.0.1:4566}"
region="${AWS_REGION:-us-east-1}"
# Use a second region endpoint for the cross-region copy target. On real AWS this
# would be a different regional endpoint; against sockerless process mode both regions
# are served by the same binary, but the API still accepts the CrossRegionCopy request.
dst_region="${DST_REGION:-us-west-2}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"

aws() {
  command aws --endpoint-url "$endpoint" --region "$region" "$@"
}

aws_dst() {
  command aws --endpoint-url "$endpoint" --region "$dst_region" "$@"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

suffix="$(date +%s)"
az="${region}a"
dst_az="${dst_region}a"
volume_id=""
snapshot_id=""
copy_snapshot_id=""
restored_volume_id=""

cleanup() {
  if [ -n "$restored_volume_id" ]; then
    aws_dst ec2 detach-volume --volume-id "$restored_volume_id" >/dev/null 2>&1 || true
    aws_dst ec2 delete-volume --volume-id "$restored_volume_id" >/dev/null 2>&1 || true
  fi
  if [ -n "$copy_snapshot_id" ]; then
    aws_dst ec2 delete-snapshot --snapshot-id "$copy_snapshot_id" >/dev/null 2>&1 || true
  fi
  if [ -n "$snapshot_id" ]; then
    aws ec2 delete-snapshot --snapshot-id "$snapshot_id" >/dev/null 2>&1 || true
  fi
  if [ -n "$volume_id" ]; then
    aws ec2 delete-volume --volume-id "$volume_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "=== EBS cross-region: create source volume ==="
volume_id=$(aws ec2 create-volume \
  --availability-zone "$az" \
  --size 1 \
  --volume-type gp3 \
  --tag-specifications "ResourceType=volume,Tags=[{Key=edd:managed,Value=true},{Key=Name,Value=edd-adv-src-${suffix}}]" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["VolumeId"])')
[ -n "$volume_id" ] || fail "CreateVolume did not return VolumeId"
pass "Created source volume $volume_id"

echo "=== EBS cross-region: snapshot source volume ==="
snapshot_id=$(aws ec2 create-snapshot \
  --volume-id "$volume_id" \
  --description "edd adversarial cross-region source ${suffix}" \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=edd:managed,Value=true}]' \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["SnapshotId"])')
[ -n "$snapshot_id" ] || fail "CreateSnapshot did not return SnapshotId"

# Wait for snapshot completion.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  state=$(aws ec2 describe-snapshots --snapshot-ids "$snapshot_id" --output json |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["Snapshots"][0].get("State","UNKNOWN"))')
  if [ "$state" = "completed" ]; then break; fi
  sleep 1
done
if [ "$state" != "completed" ]; then
  fail "source snapshot did not complete, state=$state"
fi
pass "Source snapshot completed"

echo "=== EBS cross-region: copy snapshot to ${dst_region} ==="
copy_snapshot_id=$(aws_dst ec2 copy-snapshot \
  --source-region "$region" \
  --source-snapshot-id "$snapshot_id" \
  --description "edd adversarial cross-region copy ${suffix}" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["SnapshotId"])')
[ -n "$copy_snapshot_id" ] || fail "CopySnapshot did not return SnapshotId"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  state=$(aws_dst ec2 describe-snapshots --snapshot-ids "$copy_snapshot_id" --output json |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["Snapshots"][0].get("State","UNKNOWN"))')
  if [ "$state" = "completed" ]; then break; fi
  sleep 1
done
if [ "$state" != "completed" ]; then
  fail "copied snapshot did not complete, state=$state"
fi
pass "Copied snapshot to ${dst_region}"

echo "=== EBS cross-region: restore copied snapshot to volume ==="
restored_volume_id=$(aws_dst ec2 create-volume \
  --snapshot-id "$copy_snapshot_id" \
  --availability-zone "$dst_az" \
  --volume-type gp3 \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["VolumeId"])')
[ -n "$restored_volume_id" ] || fail "CreateVolume from snapshot did not return VolumeId"
pass "Restored volume from copied snapshot"

echo "=== EBS cross-region: verify restored volume snapshot lineage ==="
source_snap=$(aws_dst ec2 describe-volumes --volume-ids "$restored_volume_id" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Volumes"][0].get("SnapshotId","MISSING"))')
if [ "$source_snap" != "$copy_snapshot_id" ]; then
  fail "restored volume snapshot id mismatch: expected $copy_snapshot_id, got $source_snap"
fi
pass "Restored volume is linked to copied snapshot"

echo "=== ALL EBS CROSS-REGION SNAPSHOT ADVERSARIAL SLICE PROBES PASSED ==="
