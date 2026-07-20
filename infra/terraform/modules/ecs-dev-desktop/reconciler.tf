# SPDX-License-Identifier: AGPL-3.0-or-later
# Scheduled reconciler sweep: EventBridge Scheduler launches the reconciler task
# on the configured cadence (idle scale-to-zero, scheduled snapshots, orphan GC).

resource "aws_scheduler_schedule" "reconciler" {
  name       = "${var.name}-reconciler"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = var.reconciler_schedule
  schedule_expression_timezone = "UTC"

  target {
    arn      = local.ecs_cluster_arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.reconciler.arn
      launch_type         = "FARGATE"
      task_count          = 1

      # Tag the launched reconciler tasks via ECS-managed tags + propagation from the task-def.
      # DO NOT set an explicit `tags = local.tags` here: the EventBridge Scheduler universal-target
      # `ecs_parameters.tags` serializes a map into the RunTask `tags` MALFORMED — each entry becomes
      # two tags keyed literally "key"/"value", so many tags collide on the same key and RunTask fails
      # `InvalidParameterException: Multiple tags contain the same key`. Combined with the missing
      # `ecs:TagResource` grant (fixed in iam.tf), this took the reconciler down ~14h (every tick
      # DLQ'd). Cost attribution instead rides `propagate_tags = "TASK_DEFINITION"` — the reconciler
      # task-def carries edd:cost-scope because Terraform owns every revision.
      enable_ecs_managed_tags = true
      propagate_tags          = "TASK_DEFINITION"

      network_configuration {
        subnets          = local.private_subnet_ids
        security_groups  = [aws_security_group.tasks.id]
        assign_public_ip = false
      }
    }

    retry_policy {
      maximum_retry_attempts = 1
    }

    # A sweep invocation that fails even after the retry goes to the DLQ instead of
    # vanishing — so a reconciler that never launches is visible (alarmed in alarms.tf).
    dead_letter_config {
      arn = aws_sqs_queue.reconciler_dlq.arn
    }
  }
}
