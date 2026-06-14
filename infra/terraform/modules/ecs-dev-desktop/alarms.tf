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
