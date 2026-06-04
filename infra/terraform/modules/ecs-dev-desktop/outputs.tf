# SPDX-License-Identifier: AGPL-3.0-or-later

output "vpc_id" {
  description = "ID of the platform VPC."
  value       = aws_vpc.this.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (ECS tasks run here)."
  value       = aws_subnet.private[*].id
}

output "public_subnet_ids" {
  description = "Public subnet IDs (the ALB lives here)."
  value       = aws_subnet.public[*].id
}

output "dynamodb_table_name" {
  description = "Name of the single-table store (set DYNAMODB_TABLE to this)."
  value       = aws_dynamodb_table.this.name
}

output "dynamodb_table_arn" {
  description = "ARN of the single-table store."
  value       = aws_dynamodb_table.this.arn
}

output "kms_key_arn" {
  description = "ARN of the platform KMS key."
  value       = aws_kms_key.this.arn
}

output "ecs_cluster_name" {
  description = "ECS cluster name (set ECS_CLUSTER to this)."
  value       = aws_ecs_cluster.this.name
}

output "ecs_cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "control_plane_repository_url" {
  description = "ECR repository URL for the control-plane app image (push here)."
  value       = aws_ecr_repository.control_plane.repository_url
}

output "golden_repository_urls" {
  description = "Map of golden base-image name → ECR repository URL."
  value       = { for k, repo in aws_ecr_repository.golden : k => repo.repository_url }
}

output "alb_dns_name" {
  description = "Public DNS name of the control-plane load balancer."
  value       = aws_lb.this.dns_name
}

output "control_plane_url" {
  description = "Control-plane URL (HTTPS via the domain when set, else the ALB over HTTP)."
  value       = local.dns_enabled ? "https://${local.control_plane_fqdn}" : "http://${aws_lb.this.dns_name}"
}

output "control_plane_task_role_arn" {
  description = "Task role ARN the control plane assumes at runtime."
  value       = aws_iam_role.control_plane.arn
}

output "ecs_infrastructure_role_arn" {
  description = "Role ECS assumes to manage workspace EBS volumes (pass on RunTask)."
  value       = aws_iam_role.ecs_infrastructure.arn
}

output "task_execution_role_arn" {
  description = "Shared ECS task-execution role ARN."
  value       = aws_iam_role.execution.arn
}

output "log_group_names" {
  description = "CloudWatch log group names (control plane, reconciler, workspaces)."
  value = {
    control_plane = aws_cloudwatch_log_group.control_plane.name
    reconciler    = aws_cloudwatch_log_group.reconciler.name
    workspaces    = aws_cloudwatch_log_group.workspaces.name
  }
}
