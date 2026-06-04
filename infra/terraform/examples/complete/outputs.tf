# SPDX-License-Identifier: AGPL-3.0-or-later

output "control_plane_url" {
  description = "URL of the control plane."
  value       = module.ecs_dev_desktop.control_plane_url
}

output "control_plane_repository_url" {
  description = "Push the control-plane image here, then deploy."
  value       = module.ecs_dev_desktop.control_plane_repository_url
}

output "dynamodb_table_name" {
  description = "Single-table store name."
  value       = module.ecs_dev_desktop.dynamodb_table_name
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.ecs_dev_desktop.ecs_cluster_name
}
