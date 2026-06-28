# SPDX-License-Identifier: AGPL-3.0-or-later

output "control_plane_url" {
  description = "URL of the control plane."
  value       = module.ecs_dev_desktop.control_plane_url
}

output "control_plane_repository_url" {
  description = "Push the control-plane image here, then deploy."
  value       = module.ecs_dev_desktop.control_plane_repository_url
}

output "golden_repository_urls" {
  description = "Map of golden base-image name → ECR repository URL (push golden images here)."
  value       = module.ecs_dev_desktop.golden_repository_urls
}

output "ssh_gateway_repository_url" {
  description = "Push the SSH-gateway image (a pinned tag) here when SSH ingress is enabled."
  value       = module.ecs_dev_desktop.ssh_gateway_repository_url
}

output "ssh_nlb_dns_name" {
  description = "Public DNS name of the SSH ingress NLB (null when SSH ingress is disabled)."
  value       = module.ecs_dev_desktop.ssh_nlb_dns_name
}

output "dynamodb_table_name" {
  description = "Single-table store name."
  value       = module.ecs_dev_desktop.dynamodb_table_name
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.ecs_dev_desktop.ecs_cluster_name
}
