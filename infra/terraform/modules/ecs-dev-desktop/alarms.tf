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
