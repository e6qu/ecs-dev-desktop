#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Prove that changing an immutable image coordinate causes Terraform to replace
# task definitions and update every corresponding runtime attachment.
set -eu
unset CDPATH

plan_file="${1:?usage: assert-task-attachment-plan.sh <plan-file> <ssh-enabled>}"
ssh_enabled="${2:?usage: assert-task-attachment-plan.sh <plan-file> <ssh-enabled>}"
here=$(cd "$(dirname "$0")" && pwd)

case "$ssh_enabled" in
  true | false) ;;
  *)
    echo "edd: ssh-enabled must be true or false" >&2
    exit 1
    ;;
esac

for command in terraform jq; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "edd: '$command' not found on PATH" >&2
    exit 1
  }
done

plan_json=$(mktemp "${TMPDIR:-/tmp}/edd-task-attachment-plan.XXXXXX")
trap 'rm -f "$plan_json"' EXIT HUP INT TERM
terraform -chdir="$here" show -json "$plan_file" >"$plan_json"

assert_update_with_unknown() { # address, after_unknown jq path
  address="$1"
  unknown_path="$2"
  if ! jq -e --arg address "$address" --arg unknown_path "$unknown_path" '
    .resource_changes[]
    | select(.address == $address)
    | select(.change.actions == ["update"])
    | .change.after_unknown
    | getpath($unknown_path | split(".") | map(if test("^[0-9]+$") then tonumber else . end)) == true
  ' "$plan_json" >/dev/null; then
    echo "edd: Terraform plan did not update $address through $unknown_path" >&2
    exit 1
  fi
  echo "edd: Terraform plan updates $address through $unknown_path"
}

assert_replacement() { # address
  address="$1"
  if ! jq -e --arg address "$address" '
    .resource_changes[]
    | select(.address == $address)
    | select(
        .change.actions == ["create", "delete"] or
        .change.actions == ["delete", "create"]
      )
    | true
  ' "$plan_json" >/dev/null; then
    echo "edd: Terraform plan did not replace $address" >&2
    exit 1
  fi
  echo "edd: Terraform plan replaces $address"
}

assert_replacement "module.edd.aws_ecs_task_definition.control_plane"
assert_replacement "module.edd.aws_ecs_task_definition.reconciler"
assert_update_with_unknown "module.edd.aws_ecs_service.control_plane" "task_definition"
assert_update_with_unknown "module.edd.aws_scheduler_schedule.reconciler" \
  "target.0.ecs_parameters.0.task_definition_arn"

if [ "$ssh_enabled" = true ]; then
  assert_replacement 'module.edd.aws_ecs_task_definition.ssh_gateway[0]'
  assert_update_with_unknown 'module.edd.aws_ecs_service.ssh_gateway[0]' "task_definition"
fi
