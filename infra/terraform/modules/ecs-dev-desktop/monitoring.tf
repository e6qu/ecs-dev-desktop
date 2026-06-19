# SPDX-License-Identifier: AGPL-3.0-or-later
# Operational monitoring: the reconciler-schedule dead-letter queue, a monthly cost
# budget guardrail, and a CloudWatch ops dashboard tying the EMF + AWS metrics into
# one pane. Alarms on these live in alarms.tf.

# Dead-letter queue for the EventBridge Scheduler → reconciler target: an invocation
# that fails even after the retry lands here instead of vanishing (alarmed in
# alarms.tf). 14-day retention gives an operator time to inspect a dropped sweep.
resource "aws_sqs_queue" "reconciler_dlq" {
  name                      = "${var.name}-reconciler-dlq"
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true    # SSE-SQS encryption at rest (no KMS key to manage)
  tags                      = local.tags
}

# Monthly cost guardrail. A runaway (e.g. a broken reaper leaking Fargate tasks, or a
# wake storm) is otherwise invisible until the bill arrives. Notifies the same SNS
# topics as the alarms at 80% (forecast) and 100% (actual). Disabled when the budget
# is 0 (the default) so the sim/dev composition creates nothing.
resource "aws_budgets_budget" "monthly" {
  count        = var.monthly_budget_usd > 0 ? 1 : 0
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = length(var.alarm_sns_topic_arns) > 0 ? { forecast = "FORECASTED", actual = "ACTUAL" } : {}
    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.key == "forecast" ? 80 : 100
      threshold_type            = "PERCENTAGE"
      notification_type         = notification.value
      subscriber_sns_topic_arns = var.alarm_sns_topic_arns
    }
  }
}

# A single ops pane: fleet size + cost, the wake SLO, control-plane availability +
# errors, the reconciler's self-healing actions and failures, and DynamoDB throttling.
# Gated like the alarms — the EMF metrics resolve only against real CloudWatch.
resource "aws_cloudwatch_dashboard" "ops" {
  count          = var.enable_metric_alarms ? 1 : 0
  dashboard_name = "${var.name}-ops"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Fleet"
          region = data.aws_region.current.region
          view   = "timeSeries"
          metrics = [
            [local.metric_namespace, "fleet.workspaces.total"],
            [local.metric_namespace, "fleet.workspaces.running"],
            [local.metric_namespace, "fleet.workspaces.stopped"],
            [local.metric_namespace, "fleet.workspaces.active"],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Fleet cost (USD)"
          region  = data.aws_region.current.region
          view    = "timeSeries"
          metrics = [[local.metric_namespace, "fleet.cost.usd"]]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Wake-on-connect latency (ms)"
          region = data.aws_region.current.region
          view   = "timeSeries"
          metrics = [
            [local.metric_namespace, "workspace.wake.latency_ms", { stat = "p50" }],
            ["...", { stat = "p99" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Control plane — healthy hosts & target 5xx"
          region = data.aws_region.current.region
          view   = "timeSeries"
          metrics = [
            ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", aws_lb.this.arn_suffix, "TargetGroup", aws_lb_target_group.control_plane.arn_suffix, { stat = "Minimum" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.this.arn_suffix, "TargetGroup", aws_lb_target_group.control_plane.arn_suffix, { stat = "Sum" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Reconciler actions"
          region = data.aws_region.current.region
          view   = "timeSeries"
          metrics = [
            [local.metric_namespace, "reconciler.idle.stopped", { stat = "Sum" }],
            [local.metric_namespace, "reconciler.snapshots.taken", { stat = "Sum" }],
            [local.metric_namespace, "reconciler.gc.deleted", { stat = "Sum" }],
            [local.metric_namespace, "reconciler.tasks.reaped", { stat = "Sum" }],
            [local.metric_namespace, "reconciler.provisioning.recovered", { stat = "Sum" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Failures — reconciler & DynamoDB throttling"
          region = data.aws_region.current.region
          view   = "timeSeries"
          metrics = [
            [local.metric_namespace, "reconciler.sweep.failed", { stat = "Sum" }],
            [local.metric_namespace, "reconciler.gc.failed", { stat = "Sum" }],
            [local.metric_namespace, "reconciler.tasks.reap_failed", { stat = "Sum" }],
            ["AWS/DynamoDB", "ReadThrottleEvents", "TableName", aws_dynamodb_table.this.name, { stat = "Sum" }],
            ["AWS/DynamoDB", "WriteThrottleEvents", "TableName", aws_dynamodb_table.this.name, { stat = "Sum" }],
          ]
        }
      },
    ]
  })
}
