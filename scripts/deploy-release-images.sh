#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Roll already-published release images into the running ECS deployment.
#
#   scripts/deploy-release-images.sh <account-id> <region> <name-prefix> <tag>
#
# This intentionally uses the current AWS task definitions as the source of truth
# for runtime wiring and changes only the container image references. Missing ECS
# services, task definitions, Scheduler schedules, or IAM permissions are release
# failures.

set -eu
unset CDPATH

account="${1:?usage: deploy-release-images.sh <account-id> <region> <name-prefix> <tag>}"
region="${2:?usage: deploy-release-images.sh <account-id> <region> <name-prefix> <tag>}"
prefix="${3:?usage: deploy-release-images.sh <account-id> <region> <name-prefix> <tag>}"
tag="${4:?usage: deploy-release-images.sh <account-id> <region> <name-prefix> <tag>}"

for c in aws jq mktemp; do
  command -v "$c" >/dev/null 2>&1 || {
    echo "edd: '$c' not found on PATH" >&2
    exit 1
  }
done

registry="${account}.dkr.ecr.${region}.amazonaws.com"
cluster="${prefix}-workspaces"
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

  jq --arg container "$container" --arg image "$image" '
    .taskDefinition
    | .containerDefinitions = (
        .containerDefinitions
        | map(if .name == $container then .image = $image else . end)
      )
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
ssh_task_definition=$(register_from_current "${prefix}-ssh-gateway" "ssh-gateway" "$ssh_image")

update_service "$control_service" "$control_task_definition"
update_service "$ssh_service" "$ssh_task_definition"
update_reconciler_schedule "$reconciler_task_definition"

echo "edd: waiting for ECS services to stabilize"
aws ecs wait services-stable \
  --region "$region" \
  --cluster "$cluster" \
  --services "$control_service" "$ssh_service"

cat <<EOF
edd: release images deployed
  control-plane = ${control_task_definition}
  reconciler    = ${reconciler_task_definition}
  ssh-gateway   = ${ssh_task_definition}
EOF
