# CloudWatch alarms on the EMF metrics the control plane + reconciler emit. The
# namespace MUST match `EDD_METRIC_NAMESPACE` in @edd/core. Gated by
# var.enable_metric_alarms: the sockerless simulator exposes no CloudWatch
# metrics/alarms endpoint, so the terraform-sim composition disables these (the
# metrics ride CloudWatch EMF, which only resolves against real AWS).

locals {
  # Keep in sync with EDD_METRIC_NAMESPACE (@edd/core observability/metrics.ts).
  metric_namespace = "edd/control-plane"
}

# A reconciler sweep threw before completing — snapshots/scale-to-zero/GC may be
# silently not running. Any failure in the alarm window fires.
resource "aws_cloudwatch_metric_alarm" "reconciler_failed" {
  count               = var.enable_metric_alarms ? 1 : 0
  alarm_name          = "${var.name}-reconciler-failed"
  alarm_description   = "A reconciler maintenance sweep threw before completing."
  namespace           = local.metric_namespace
  metric_name         = "reconciler.sweep.failed"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = local.tags
}

# Wake-on-connect cold-start latency (scale-to-zero → hydrate) p99 is high — the
# core SLO degrading.
resource "aws_cloudwatch_metric_alarm" "wake_latency_high" {
  count               = var.enable_metric_alarms ? 1 : 0
  alarm_name          = "${var.name}-wake-latency-high"
  alarm_description   = "Wake-on-connect cold-start latency p99 exceeds the threshold."
  namespace           = local.metric_namespace
  metric_name         = "workspace.wake.latency_ms"
  extended_statistic  = "p99"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.wake_latency_alarm_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = local.tags
}

# Control plane is DOWN — no healthy task behind the ALB for several minutes. ECS
# self-heals (the service replaces unhealthy tasks; the circuit breaker rolls a bad
# deploy back), but a crash-loop or a stuck dependency keeps HealthyHostCount at 0,
# and this is the signal a human needs. Uses the AWS-managed ALB metric so it fires
# even when the control plane itself can't emit (its own EMF would be silent).
resource "aws_cloudwatch_metric_alarm" "control_plane_unhealthy" {
  count             = var.enable_metric_alarms ? 1 : 0
  alarm_name        = "${var.name}-control-plane-unhealthy"
  alarm_description = "No healthy control-plane task behind the ALB (the control plane is down)."
  namespace         = "AWS/ApplicationELB"
  metric_name       = "HealthyHostCount"
  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = aws_lb_target_group.control_plane.arn_suffix
  }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3 # ~3 min with no healthy host (ride out a normal deploy)
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = local.tags
}

# Control plane is UP but ERRORING — sustained target 5xx responses (the companion
# to the unhealthy alarm: down vs degraded). Also an AWS-managed ALB metric, so it
# is independent of the app's own error-rate metric.
resource "aws_cloudwatch_metric_alarm" "control_plane_5xx" {
  count             = var.enable_metric_alarms ? 1 : 0
  alarm_name        = "${var.name}-control-plane-5xx"
  alarm_description = "Control-plane target 5xx responses exceed the threshold (the API is erroring)."
  namespace         = "AWS/ApplicationELB"
  metric_name       = "HTTPCode_Target_5XX_Count"
  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = aws_lb_target_group.control_plane.arn_suffix
  }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.control_plane_5xx_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = local.tags
}

# Reconciler LIVENESS — no sweep ran in the window. The reconciler-failed alarm only
# fires when a sweep RUNS and throws; if the scheduled task never launches (capacity,
# image pull, a broken schedule), no sweep runs and no metric is emitted — the whole
# self-healing engine is silently dead. `treat_missing_data = breaching` turns that
# silence into the alarm: a Sum of `reconciler.sweep.count` below 1 over the window
# (set comfortably above the schedule cadence) means it is not running.
resource "aws_cloudwatch_metric_alarm" "reconciler_not_running" {
  count               = var.enable_metric_alarms ? 1 : 0
  alarm_name          = "${var.name}-reconciler-not-running"
  alarm_description   = "No reconciler sweep ran in the window — the self-healing engine is down."
  namespace           = local.metric_namespace
  metric_name         = "reconciler.sweep.count"
  statistic           = "Sum"
  period              = var.reconciler_liveness_period
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = local.tags
}

# Reconciler self-healing FAILURES — a delete/stop the sweep retried still failed.
# A burst of blocked privileged-tool attempts (docker/sudo/… from inside workspaces)
# worth an operator's eye — curiosity, a misunderstanding, or probing. The sandbox
# already blocked them; this surfaces the pattern.
resource "aws_cloudwatch_metric_alarm" "security_privilege_attempts" {
  count               = var.enable_metric_alarms ? 1 : 0
  alarm_name          = "${var.name}-security-privilege-attempts"
  alarm_description   = "Workspaces attempted privileged tools the sandbox blocks (docker/sudo/…) above the threshold."
  namespace           = local.metric_namespace
  metric_name         = "security.privilege_attempt"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.privilege_attempt_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = local.tags
}

# A workspace stuck in `error` (unrecoverable — no snapshot, or one deleted out-of-band)
# can't be self-healed forward; it needs a human to recreate or delete it. Sustained
# above the threshold across the window = page someone.
resource "aws_cloudwatch_metric_alarm" "workspaces_stuck_error" {
  count               = var.enable_metric_alarms ? 1 : 0
  alarm_name          = "${var.name}-workspaces-stuck-error"
  alarm_description   = "Workspaces stuck in unrecoverable `error` (self-recovery can't move them forward; needs a human)."
  namespace           = local.metric_namespace
  metric_name         = "reconciler.workspaces.error"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.stuck_error_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = local.tags
}

# A finish-delete that keeps failing (e.g. a persistent final-snapshot error) leaves a
# `deleting` tombstone that never converges — investigate.
resource "aws_cloudwatch_metric_alarm" "reconciler_deletions_failed" {
  count               = var.enable_metric_alarms ? 1 : 0
  alarm_name          = "${var.name}-reconciler-deletions-failed"
  alarm_description   = "Reconciler could not finish tearing down a deleting workspace (stuck tombstone)."
  namespace           = local.metric_namespace
  metric_name         = "reconciler.deletions.failed"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = local.tags
}

# A non-zero count means an orphan volume (gc.failed) or task (tasks.reap_failed) is
# stuck and leaking cost; the sweep keeps running (best-effort) but a human is needed.
resource "aws_cloudwatch_metric_alarm" "reconciler_gc_failed" {
  count               = var.enable_metric_alarms ? 1 : 0
  alarm_name          = "${var.name}-reconciler-gc-failed"
  alarm_description   = "Reconciler GC failed to delete an orphan volume/snapshot (a stuck, cost-leaking orphan)."
  namespace           = local.metric_namespace
  metric_name         = "reconciler.gc.failed"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "reconciler_reap_failed" {
  count               = var.enable_metric_alarms ? 1 : 0
  alarm_name          = "${var.name}-reconciler-reap-failed"
  alarm_description   = "Reconciler failed to stop an orphan workspace task (a stuck, cost-leaking Fargate task)."
  namespace           = local.metric_namespace
  metric_name         = "reconciler.tasks.reap_failed"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = local.tags
}

# DynamoDB throttling — sustained read/write throttle events on the single table.
# The clients now retry with adaptive backoff, but persistent throttling at 200+
# scale means the table needs attention (it survives a burst, not a sustained one).
resource "aws_cloudwatch_metric_alarm" "dynamodb_throttle" {
  count               = var.enable_metric_alarms ? 1 : 0
  alarm_name          = "${var.name}-dynamodb-throttle"
  alarm_description   = "Sustained DynamoDB read/write throttling on the control-plane table."
  evaluation_periods  = 3
  threshold           = var.dynamodb_throttle_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = local.tags

  metric_query {
    id          = "throttle"
    expression  = "reads + writes"
    label       = "Read + Write throttle events"
    return_data = true
  }
  metric_query {
    id = "reads"
    metric {
      namespace   = "AWS/DynamoDB"
      metric_name = "ReadThrottleEvents"
      dimensions  = { TableName = aws_dynamodb_table.this.name }
      period      = 300
      stat        = "Sum"
    }
  }
  metric_query {
    id = "writes"
    metric {
      namespace   = "AWS/DynamoDB"
      metric_name = "WriteThrottleEvents"
      dimensions  = { TableName = aws_dynamodb_table.this.name }
      period      = 300
      stat        = "Sum"
    }
  }
}

# Reconciler DLQ depth — a scheduled invocation that failed even after the retry
# lands in the dead-letter queue. Any message means a sweep was dropped (distinct
# from a sweep that ran and threw, which `reconciler-failed` covers).
resource "aws_cloudwatch_metric_alarm" "reconciler_dlq" {
  count               = var.enable_metric_alarms ? 1 : 0
  alarm_name          = "${var.name}-reconciler-dlq"
  alarm_description   = "A reconciler schedule invocation failed and landed in the dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.reconciler_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = local.tags
}
