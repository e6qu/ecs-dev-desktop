# SPDX-License-Identifier: AGPL-3.0-or-later
# CloudWatch log groups. On AWS, the admin Logs/Audit screen's LogSource adapter
# (Phase 8C) reads these; CloudTrail (account-level) backs the audit feed.

resource "aws_cloudwatch_log_group" "control_plane" {
  name              = "/${var.name}/control-plane"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "reconciler" {
  name              = "/${var.name}/reconciler"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "workspaces" {
  name              = "/${var.name}/workspaces"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
  tags              = local.tags
}
