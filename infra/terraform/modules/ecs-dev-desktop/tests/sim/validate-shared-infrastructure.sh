#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Verifies that the module composes with an environment-owned VPC and ECS cluster.
set -eu
unset CDPATH

HERE="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
ENDPOINT="${SIM_ENDPOINT:-http://127.0.0.1:4566}"

state_list="$(terraform -chdir="${HERE}" state list)"

assert_present() {
  resource="$1"
  if printf '%s\n' "${state_list}" | grep -Fqx "${resource}"; then
    printf 'PASS  shared infrastructure: %s exists\n' "${resource}"
  else
    printf 'FAIL  shared infrastructure: expected %s in Terraform state\n' "${resource}"
    exit 1
  fi
}

assert_absent_prefix() {
  prefix="$1"
  if printf '%s\n' "${state_list}" | grep -Fq "${prefix}"; then
    printf 'FAIL  shared infrastructure: unexpectedly managed %s\n' "${prefix}"
    exit 1
  fi
  printf 'PASS  shared infrastructure: does not manage %s\n' "${prefix}"
}

assert_present 'aws_vpc.shared'
assert_present 'aws_ecs_cluster.shared'
assert_present 'module.edd_shared.aws_ecs_service.control_plane'
assert_absent_prefix 'module.edd_shared.aws_vpc.this'
assert_absent_prefix 'module.edd_shared.aws_ecs_cluster.this'
assert_absent_prefix 'module.edd_shared.aws_nat_gateway.this'
assert_absent_prefix 'module.edd_shared.aws_vpc_endpoint.'

service_cluster="$(aws --endpoint-url "${ENDPOINT}" ecs describe-services \
  --cluster edd-shared-sim \
  --services eddsharedsim-control-plane \
  --query 'services[0].clusterArn' --output text)"
expected_cluster='arn:aws:ecs:us-east-1:123456789012:cluster/edd-shared-sim'
if [ "${service_cluster}" = "${expected_cluster}" ]; then
  printf 'PASS  shared infrastructure: control plane uses the environment ECS cluster\n'
else
  printf 'FAIL  shared infrastructure: service cluster expected %s got %s\n' \
    "${expected_cluster}" "${service_cluster}"
  exit 1
fi
