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

output "ssh_gateway_repository_url" {
  description = "ECR repository URL for the SSH-gateway image (push here)."
  value       = aws_ecr_repository.ssh_gateway.repository_url
}

output "ssh_nlb_dns_name" {
  description = "Public DNS name of the SSH ingress NLB (null when SSH ingress is disabled)."
  value       = local.ssh_enabled ? aws_lb.ssh[0].dns_name : null
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

# ---- Scale-to-zero entry (CloudFront + wake Lambda) ----

output "cloudfront_distribution_id" {
  description = "CloudFront distribution id fronting app.<domain> (null when CloudFront is disabled)."
  value       = local.cloudfront_enabled ? aws_cloudfront_distribution.control_plane[0].id : null
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name (the *.cloudfront.net host the app.<domain> alias targets; null when disabled)."
  value       = local.cloudfront_enabled ? aws_cloudfront_distribution.control_plane[0].domain_name : null
}

output "wake_lambda_name" {
  description = "Name of the wake Lambda that scales the control plane off zero (null when CloudFront is disabled)."
  value       = local.cloudfront_enabled ? aws_lambda_function.wake[0].function_name : null
}

output "wake_lambda_function_url" {
  description = "Wake Lambda Function URL used as the CloudFront failover origin (null when CloudFront is disabled)."
  value       = local.cloudfront_enabled ? aws_lambda_function_url.wake[0].function_url : null
}

# ---- Admin-managed CLOUDFRONT WAF (coordinates the control plane needs) ----

output "cloudfront_web_acl_arn" {
  description = "ARN of the CLOUDFRONT-scope WAFv2 web ACL the control plane manages (null when disabled)."
  value       = local.cloudfront_waf_enabled ? aws_wafv2_web_acl.cloudfront[0].arn : null
}

output "cloudfront_web_acl_id" {
  description = "Id of the CLOUDFRONT-scope WAFv2 web ACL (null when disabled)."
  value       = local.cloudfront_waf_enabled ? aws_wafv2_web_acl.cloudfront[0].id : null
}

output "cloudfront_ip_set_arn" {
  description = "ARN of the admin CIDR IP set the control plane populates (null when disabled)."
  value       = local.cloudfront_waf_enabled ? aws_wafv2_ip_set.cloudfront_admin[0].arn : null
}

output "cloudfront_ip_set_id" {
  description = "Id of the admin CIDR IP set (null when disabled)."
  value       = local.cloudfront_waf_enabled ? aws_wafv2_ip_set.cloudfront_admin[0].id : null
}

output "cloudfront_ip_set_name" {
  description = "Name of the admin CIDR IP set (null when disabled)."
  value       = local.cloudfront_waf_enabled ? aws_wafv2_ip_set.cloudfront_admin[0].name : null
}

output "ecs_infrastructure_role_arn" {
  description = "Role ECS assumes to manage workspace EBS volumes (pass on RunTask)."
  value       = aws_iam_role.ecs_infrastructure.arn
}

output "workspace_task_role_arn" {
  description = "Runtime task role ARN for per-workspace containers (pass on RunTask)."
  value       = aws_iam_role.workspace.arn
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

output "reconciler_task_role_arn" {
  description = "Task role ARN the reconciler assumes at runtime."
  value       = aws_iam_role.reconciler.arn
}

output "alb_security_group_id" {
  description = "ID of the ALB security group."
  value       = aws_security_group.alb.id
}

output "tasks_security_group_id" {
  description = "ID of the control-plane + reconciler ECS tasks security group."
  value       = aws_security_group.tasks.id
}

output "workspaces_security_group_id" {
  description = "ID of the per-user workspace tasks security group (editor/sshd from the control plane only)."
  value       = aws_security_group.workspaces.id
}

output "nat_mode" {
  description = "Private-subnet egress mechanism in effect (gateway | instance)."
  value       = var.nat_mode
}

output "nat_instance_eni_id" {
  description = "ENI id of the fck-nat NAT instance (null unless nat_mode = instance)."
  value       = var.nat_mode == "instance" ? module.fck_nat[0].eni_id : null
}
