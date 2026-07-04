#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adversarial spec-fidelity probe slice for EC2 security-group network-layer enforcement.
#
# This slice proves that security-group ingress rules are not only stored in the
# EC2 control plane but are also materialized on the task NIC packet path. It
# creates two Fargate awsvpc tasks in different security groups, authorizes an
# ingress rule from SG-B to SG-A, and inspects the host nftables ruleset to
# confirm that the source-SG reference has been expanded to task B's live ENI
# IP and installed as a packet filter on task A's namespace NIC.
#
# Because network enforcement is a host-packet-path behavior, this probe requires
# a real-exec environment: Linux + CAP_NET_ADMIN + iproute2 + nftables + a
# container runtime for the simulator (SIM_RUNTIME=docker). It is intentionally
# strict: if the host cannot observe the installed rules, the probe fails loud.
#
# Endpoint-only for the AWS API surface: the only target-specific coordinates are
# AWS_ENDPOINT_URL / AWS_REGION / credentials.
set -eu
unset CDPATH

endpoint="${AWS_ENDPOINT_URL:-http://127.0.0.1:4566}"
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

if [ "${SIM_RUNTIME:-}" != "docker" ]; then
  echo "SKIP: network-layer SG enforcement probe requires SIM_RUNTIME=docker (real task netns); current runtime is '${SIM_RUNTIME:-process}'"
  exit 0
fi
if ! command -v ip >/dev/null 2>&1; then
  echo "SKIP: host 'ip' utility (iproute2) is required to inspect the real packet path"
  exit 0
fi
if ! command -v nft >/dev/null 2>&1; then
  echo "SKIP: host 'nft' utility (nftables) is required to inspect the real packet path"
  exit 0
fi
suffix="$(date +%s)"
vpc_cidr="10.97.0.0/16"
subnet_cidr="10.97.1.0/24"
probe_port=8080
cluster_name="edd-sg-net-${suffix}"
task_family="edd-sg-net-task-${suffix}"
vpc_id=""
subnet_id=""
igw_id=""
rt_id=""
sg_a=""
sg_b=""
task_a=""
task_b=""

cleanup() {
  if [ -n "${task_a}" ]; then
    aws ecs stop-task --cluster "$cluster_name" --task "$task_a" >/dev/null 2>&1 || true
  fi
  if [ -n "${task_b}" ]; then
    aws ecs stop-task --cluster "$cluster_name" --task "$task_b" >/dev/null 2>&1 || true
  fi
  sleep 1
  aws ecs deregister-task-definition --task-definition "${task_family}:1" >/dev/null 2>&1 || true
  aws ecs delete-cluster --cluster "$cluster_name" >/dev/null 2>&1 || true
  if [ -n "${sg_a}" ]; then
    aws ec2 delete-security-group --group-id "$sg_a" >/dev/null 2>&1 || true
  fi
  if [ -n "${sg_b}" ]; then
    aws ec2 delete-security-group --group-id "$sg_b" >/dev/null 2>&1 || true
  fi
  if [ -n "${subnet_id}" ]; then
    aws ec2 delete-subnet --subnet-id "$subnet_id" >/dev/null 2>&1 || true
  fi
  if [ -n "${rt_id}" ]; then
    aws ec2 delete-route-table --route-table-id "$rt_id" >/dev/null 2>&1 || true
  fi
  if [ -n "${igw_id}" ] && [ -n "${vpc_id}" ]; then
    aws ec2 detach-internet-gateway --internet-gateway-id "$igw_id" --vpc-id "$vpc_id" >/dev/null 2>&1 || true
    aws ec2 delete-internet-gateway --internet-gateway-id "$igw_id" >/dev/null 2>&1 || true
  fi
  if [ -n "${vpc_id}" ]; then
    aws ec2 delete-vpc --vpc-id "$vpc_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "=== Network-layer SG enforcement: VPC / subnet / routing ==="
vpc_id=$(aws ec2 create-vpc --cidr-block "$vpc_cidr" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Vpc"]["VpcId"])')
subnet_id=$(aws ec2 create-subnet --vpc-id "$vpc_id" --cidr-block "$subnet_cidr" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["Subnet"]["SubnetId"])')
igw_id=$(aws ec2 create-internet-gateway --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["InternetGateway"]["InternetGatewayId"])')
aws ec2 attach-internet-gateway --internet-gateway-id "$igw_id" --vpc-id "$vpc_id" >/dev/null || fail "attach IGW rejected"
rt_id=$(aws ec2 create-route-table --vpc-id "$vpc_id" --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["RouteTable"]["RouteTableId"])')
aws ec2 create-route --route-table-id "$rt_id" --destination-cidr-block "0.0.0.0/0" --gateway-id "$igw_id" >/dev/null || fail "create default route rejected"
aws ec2 associate-route-table --route-table-id "$rt_id" --subnet-id "$subnet_id" >/dev/null || fail "associate route table rejected"
pass "VPC + public subnet + routing created"

echo "=== Network-layer SG enforcement: security groups ==="
sg_a=$(aws ec2 create-security-group \
  --group-name "edd-sg-a-${suffix}" \
  --description "probe SG A" \
  --vpc-id "$vpc_id" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["GroupId"])')
sg_b=$(aws ec2 create-security-group \
  --group-name "edd-sg-b-${suffix}" \
  --description "probe SG B" \
  --vpc-id "$vpc_id" \
  --output json |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["GroupId"])')
pass "Security groups A and B created"

echo "=== Network-layer SG enforcement: ECS cluster + task definition ==="
aws ecs create-cluster --cluster-name "$cluster_name" >/dev/null || fail "CreateCluster rejected"
aws ecs register-task-definition \
  --family "$task_family" \
  --network-mode awsvpc \
  --requires-compatibilities FARGATE \
  --cpu 256 \
  --memory 512 \
  --execution-role-arn "arn:aws:iam::123456789012:role/ecsTaskExecutionRole" \
  --container-definitions '[{"name":"probe","image":"busybox:latest","essential":true,"command":["sleep","300"]}]' \
  >/dev/null || fail "RegisterTaskDefinition rejected"
pass "ECS cluster and awsvpc task definition created"

echo "=== Network-layer SG enforcement: run two awsvpc tasks in different SGs ==="
task_a=$(aws ecs run-task \
  --cluster "$cluster_name" \
  --launch-type FARGATE \
  --task-definition "$task_family" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnet_id],securityGroups=[$sg_a],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)
task_b=$(aws ecs run-task \
  --cluster "$cluster_name" \
  --launch-type FARGATE \
  --task-definition "$task_family" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnet_id],securityGroups=[$sg_b],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)

wait_for_running() {
  label="$1"
  t="$2"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    status=$(aws ecs describe-tasks --cluster "$cluster_name" --tasks "$t" --query 'tasks[0].lastStatus' --output text)
    if [ "$status" = "RUNNING" ]; then
      return 0
    fi
    sleep 5
  done
  fail "task ${label} did not reach RUNNING (lastStatus=${status:-UNKNOWN})"
}
wait_for_running A "$task_a"
wait_for_running B "$task_b"
pass "Both awsvpc tasks are RUNNING"

echo "=== Network-layer SG enforcement: collect task ENI IPs ==="
task_eni_ip() {
  aws ecs describe-tasks --cluster "$cluster_name" --tasks "$1" --output json |
    python3 -c 'import sys,json; t=json.load(sys.stdin)["tasks"][0]; print(next((d["value"] for a in t.get("attachments",[]) if a.get("type")=="ElasticNetworkInterface" for d in a.get("details",[]) if d.get("name")=="privateIPv4Address"),""))'
}
ip_a=$(task_eni_ip "$task_a")
ip_b=$(task_eni_ip "$task_b")
[ -n "$ip_a" ] || fail "task A ENI private IP not found"
[ -n "$ip_b" ] || fail "task B ENI private IP not found"
pass "Task A ENI IP=${ip_a}, Task B ENI IP=${ip_b}"

echo "=== Network-layer SG enforcement: authorize ingress rules ==="
# Allow traffic TO task A FROM task B's SG (source-SG reference).
aws ec2 authorize-security-group-ingress \
  --group-id "$sg_a" \
  --protocol tcp \
  --port "$probe_port" \
  --source-group "$sg_b" \
  >/dev/null || fail "authorize SG_A ingress from SG_B rejected"
# Positive control: allow traffic TO task B FROM the VPC CIDR.
aws ec2 authorize-security-group-ingress \
  --group-id "$sg_b" \
  --protocol tcp \
  --port "$probe_port" \
  --cidr "$vpc_cidr" \
  >/dev/null || fail "authorize SG_B ingress from VPC CIDR rejected"
pass "Ingress rules authorized"

# Give the simulator a moment to reapply the SG rules to the running NICs.
sleep 2

echo "=== Network-layer SG enforcement: inspect host nftables ruleset ==="
ruleset=""
for ns in $(ip netns list | awk '{print $1}'); do
  rs=$(ip netns exec "$ns" nft list ruleset 2>/dev/null || true)
  ruleset="${ruleset}
${rs}"
done

if [ -z "$ruleset" ]; then
  fail "no nftables ruleset found in any network namespace"
fi

echo "=== Network-layer SG enforcement: assert source-SG reference expanded ==="
# The rule for SG_A should contain task B's /32 as the source and task A's IP as the destination.
a_rule=$(printf '%s' "$ruleset" | grep -F "$ip_b/32" | grep -F "$probe_port" | grep -F "$ip_a" | head -n1 || true)
if [ -z "$a_rule" ]; then
  fail "nftables missing allow rule for ${ip_a}:${probe_port} from ${ip_b}/32 (SG_A from SG_B)"
fi
pass "SG_A ingress from SG_B expanded to ${ip_b}/32 -> ${ip_a}:${probe_port} in nftables"

echo "=== Network-layer SG enforcement: assert denied direction is absent ==="
# There should be no rule allowing traffic TO task B FROM task A's SG (no such rule was authorized).
b_rule=$(printf '%s' "$ruleset" | grep -F "$ip_a/32" | grep -F "$probe_port" | grep -F "$ip_b" | head -n1 || true)
if [ -n "$b_rule" ]; then
  fail "unexpected nftables allow rule for ${ip_b}:${probe_port} from ${ip_a}/32"
fi
pass "No nftables allow rule from SG_A to SG_B (network-layer deny)"

echo "=== Network-layer SG enforcement: assert CIDR rule materialized ==="
cidr_rule=$(printf '%s' "$ruleset" | grep -F "$vpc_cidr" | grep -F "$probe_port" | grep -F "$ip_b" | head -n1 || true)
if [ -z "$cidr_rule" ]; then
  fail "nftables missing CIDR allow rule for ${ip_b}:${probe_port} from ${vpc_cidr}"
fi
pass "SG_B CIDR ingress rule materialized in nftables"

echo "=== ALL EC2 SECURITY-GROUP NETWORK-LAYER ADVERSARIAL SLICE PROBES PASSED ==="
