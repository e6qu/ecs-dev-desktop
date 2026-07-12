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

      # Tag the launched reconciler tasks (incl. edd:cost-scope) so their Fargate usage is
      # cost-attributable, same as the control-plane service. Short-lived, so a small cost,
      # but otherwise invisible to a tag-scoped Cost Explorer query.
      enable_ecs_managed_tags = true
      propagate_tags          = "TASK_DEFINITION"
      tags                    = local.tags

      network_configuration {
        subnets          = aws_subnet.private[*].id
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

  lifecycle {
    # The reconciler image/task-definition is owned by the RELEASE PIPELINE, not Terraform:
    # deploy-release-images.sh registers a fresh reconciler task-def and repoints this schedule at
    # it out-of-band on each deploy. Without this, a later `terraform apply` would revert the
    # schedule to the Terraform-managed (stale) revision. Terraform creates the initial schedule +
    # task-def; the pipeline owns the image rolls thereafter. (Same rationale as the ECS services.)
    ignore_changes = [target[0].ecs_parameters[0].task_definition_arn]
  }
}
