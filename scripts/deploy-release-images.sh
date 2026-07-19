#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Roll already-published release images into the running ECS deployment.
#
#   scripts/deploy-release-images.sh <account-id> <region> <name-prefix> <ecs-cluster> <tag> <ssh-gateway-enabled>
#
# This intentionally uses the current AWS task definitions as the source of truth
# for runtime wiring and changes only the container image references. Missing ECS
# services, task definitions, Scheduler schedules, or IAM permissions for an
# explicitly enabled component are release failures.
#
# Environment:
#   EDD_DEPLOY_ARCH   Fargate CPU architecture to pin on the rolled task defs:
#                     "arm64" (default; Graviton) or "amd64". The service has
#                     lifecycle ignore_changes[task_definition], so it never adopts
#                     Terraform's runtimePlatform — this is the ONLY thing that flips
#                     the running services' arch, so it is set EXPLICITLY here (not
#                     merely preserved from the current, possibly-amd64, task def).
#                     The pushed image at <tag> must be a multiarch manifest.

set -eu
unset CDPATH

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/lib/validate-image-tag.sh
. "$here/lib/validate-image-tag.sh"

usage='usage: deploy-release-images.sh <account-id> <region> <name-prefix> <ecs-cluster> <tag> <ssh-gateway-enabled>'
account="${1:?$usage}"
region="${2:?$usage}"
prefix="${3:?$usage}"
cluster="${4:?$usage}"
tag="${5:?$usage}"
ssh_gateway_enabled="${6:?$usage}"
validate_image_tag "$tag" "tag" || exit 1

case "$ssh_gateway_enabled" in
  true | false) ;;
  *)
    echo "edd: ssh-gateway-enabled must be true or false (got '$ssh_gateway_enabled')" >&2
    exit 1
    ;;
esac

deploy_arch="${EDD_DEPLOY_ARCH:-arm64}"
case "$deploy_arch" in
  arm64) ecs_arch="ARM64" ;;
  amd64) ecs_arch="X86_64" ;;
  *)
    echo "edd: EDD_DEPLOY_ARCH must be arm64 or amd64 (got '$deploy_arch')" >&2
    exit 1
    ;;
esac

for c in aws jq mktemp; do
  command -v "$c" >/dev/null 2>&1 || {
    echo "edd: '$c' not found on PATH" >&2
    exit 1
  }
done

registry="${account}.dkr.ecr.${region}.amazonaws.com"
control_service="${prefix}-control-plane"
ssh_service="${prefix}-ssh-gateway"
schedule="${prefix}-reconciler"
control_image="${registry}/${prefix}/control-plane:${tag}"
ssh_image="${registry}/${prefix}/ssh-gateway:${tag}"

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/edd-release-deploy.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM

register_from_current() {
  family="$1"
  container="$2"
  image="$3"
  current_json="${tmpdir}/${family}-current.json"
  input_json="${tmpdir}/${family}-register.json"

  echo "edd: reading current task definition ${family}" >&2
  aws ecs describe-task-definition \
    --region "$region" \
    --task-definition "$family" \
    --output json >"$current_json"

  if ! jq -e --arg container "$container" \
    '.taskDefinition.containerDefinitions | any(.name == $container)' \
    "$current_json" >/dev/null; then
    echo "edd: task definition ${family} has no container named ${container}" >&2
    exit 1
  fi

  jq --arg container "$container" --arg image "$image" --arg arch "$ecs_arch" '
    .taskDefinition
    | .containerDefinitions = (
        .containerDefinitions
        | map(if .name == $container then .image = $image else . end)
      )
    # Force the CPU architecture (default ARM64/Graviton) rather than preserving whatever the
    # current task def has: the service ignore_changes[task_definition], so this roll is the only
    # thing that flips the running arch. operatingSystemFamily is required alongside cpuArchitecture.
    | .runtimePlatform = { cpuArchitecture: $arch, operatingSystemFamily: "LINUX" }
    | {
        family,
        taskRoleArn,
        executionRoleArn,
        networkMode,
        containerDefinitions,
        volumes,
        placementConstraints,
        requiresCompatibilities,
        cpu,
        memory,
        ipcMode,
        pidMode,
        proxyConfiguration,
        inferenceAccelerators,
        ephemeralStorage,
        runtimePlatform
      }
    | with_entries(select(.value != null and .value != []))
  ' "$current_json" >"$input_json"

  arn=$(aws ecs register-task-definition \
    --region "$region" \
    --cli-input-json "file://${input_json}" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

  if [ -z "$arn" ] || [ "$arn" = "None" ]; then
    echo "edd: register-task-definition returned no ARN for ${family}" >&2
    exit 1
  fi
  printf '%s\n' "$arn"
}

update_service() {
  service="$1"
  task_definition="$2"
  echo "edd: updating ECS service ${service} to ${task_definition}"
  aws ecs update-service \
    --region "$region" \
    --cluster "$cluster" \
    --service "$service" \
    --task-definition "$task_definition" >/dev/null
}

update_reconciler_schedule() {
  task_definition="$1"
  schedule_json="${tmpdir}/schedule.json"
  schedule_input_json="${tmpdir}/schedule-update.json"

  echo "edd: reading Scheduler schedule ${schedule}"
  aws scheduler get-schedule \
    --region "$region" \
    --name "$schedule" \
    --output json >"$schedule_json"

  group=$(jq -r '.GroupName' "$schedule_json")
  expression=$(jq -r '.ScheduleExpression' "$schedule_json")
  timezone=$(jq -r '.ScheduleExpressionTimezone // empty' "$schedule_json")
  state=$(jq -r '.State' "$schedule_json")

  if [ -z "$group" ] || [ "$group" = "null" ]; then
    echo "edd: Scheduler schedule ${schedule} has no GroupName" >&2
    exit 1
  fi
  if [ -z "$expression" ] || [ "$expression" = "null" ]; then
    echo "edd: Scheduler schedule ${schedule} has no ScheduleExpression" >&2
    exit 1
  fi
  if [ -z "$timezone" ]; then
    echo "edd: Scheduler schedule ${schedule} has no ScheduleExpressionTimezone" >&2
    exit 1
  fi
  if [ -z "$state" ] || [ "$state" = "null" ]; then
    echo "edd: Scheduler schedule ${schedule} has no State" >&2
    exit 1
  fi

  jq --arg task_definition "$task_definition" '
    {
      Name,
      GroupName,
      ScheduleExpression,
      ScheduleExpressionTimezone,
      State,
      FlexibleTimeWindow,
      Target: (.Target | .EcsParameters.TaskDefinitionArn = $task_definition)
    }
    + (if .ActionAfterCompletion != null then { ActionAfterCompletion } else {} end)
    + (if .Description != null then { Description } else {} end)
    + (if .StartDate != null then { StartDate } else {} end)
    + (if .EndDate != null then { EndDate } else {} end)
    + (if .KmsKeyArn != null then { KmsKeyArn } else {} end)
  ' "$schedule_json" >"$schedule_input_json"

  echo "edd: updating Scheduler schedule ${schedule} to ${task_definition}"
  aws scheduler update-schedule \
    --region "$region" \
    --cli-input-json "file://${schedule_input_json}" >/dev/null
}

control_task_definition=$(register_from_current "${prefix}-control-plane" "control-plane" "$control_image")
reconciler_task_definition=$(register_from_current "${prefix}-reconciler" "reconciler" "$control_image")
update_service "$control_service" "$control_task_definition"
update_reconciler_schedule "$reconciler_task_definition"

ssh_task_definition=disabled
if [ "$ssh_gateway_enabled" = true ]; then
  ssh_task_definition=$(register_from_current "${prefix}-ssh-gateway" "ssh-gateway" "$ssh_image")
  update_service "$ssh_service" "$ssh_task_definition"
else
  echo "edd: SSH gateway deployment is disabled by the explicit release topology"
fi

cat <<EOF
edd: release images submitted
  control-plane = ${control_task_definition}
  reconciler    = ${reconciler_task_definition}
  ssh-gateway   = ${ssh_task_definition}

ECS deployment is asynchronous: the services now converge under the ECS deployment
circuit breaker and CloudWatch alarms. Run scripts/check-deployed-app.sh against
the app URL, or use the post-deploy-smoke workflow, to prove the real application
is serving the expected build.
EOF
