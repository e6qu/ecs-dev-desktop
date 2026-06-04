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
    arn      = aws_ecs_cluster.this.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.reconciler.arn
      launch_type         = "FARGATE"
      task_count          = 1

      network_configuration {
        subnets          = aws_subnet.private[*].id
        security_groups  = [aws_security_group.tasks.id]
        assign_public_ip = false
      }
    }

    retry_policy {
      maximum_retry_attempts = 1
    }
  }
}
