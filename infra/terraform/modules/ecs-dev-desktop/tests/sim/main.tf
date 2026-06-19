# SPDX-License-Identifier: AGPL-3.0-or-later
# Sim-backed test fixture: instantiates the module against the sockerless AWS
# simulator. Per AGENTS.md §6.8 the ONLY difference from real cloud is the
# endpoint (var.sim_endpoint) + dummy credentials — no module branches.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "sim_endpoint" {
  description = "Base URL of the sockerless AWS simulator."
  type        = string
  default     = "http://127.0.0.1:4566"
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    sts            = var.sim_endpoint
    ec2            = var.sim_endpoint
    ecs            = var.sim_endpoint
    ecr            = var.sim_endpoint
    dynamodb       = var.sim_endpoint
    iam            = var.sim_endpoint
    kms            = var.sim_endpoint
    elbv2          = var.sim_endpoint
    route53        = var.sim_endpoint
    acm            = var.sim_endpoint
    cloudwatch     = var.sim_endpoint
    cloudwatchlogs = var.sim_endpoint
    secretsmanager = var.sim_endpoint
    scheduler      = var.sim_endpoint
    appautoscaling = var.sim_endpoint
    cloudtrail     = var.sim_endpoint
    sqs            = var.sim_endpoint
  }
}

# NAT mode toggle. Default "gateway"; pass `-var nat_mode=instance` to exercise the
# fck-nat EC2 NAT-instance path (uses standalone ENI ops fixed upstream by #430).
variable "nat_mode" {
  description = "Exercise nat_mode=instance (fck-nat) against the sim."
  type        = string
  default     = "gateway"
}

# DNS/TLS toggle. Off by default so the always-run CI apply stays fast and green;
# `-var enable_dns=true` exercises the module's full ACM + Route53 + HTTPS path
# (dns.tf) against the sim. ACM gaps (#420/#421) were fixed upstream by #424.
variable "enable_dns" {
  description = "Exercise the module's ACM/Route53/HTTPS path against the sim."
  type        = bool
  default     = false
}

# A hosted zone for the module to write ACM-validation + alias records into. The
# module takes an *existing* zone id (route53_zone_id); the sim test creates one.
resource "aws_route53_zone" "test" {
  count = var.enable_dns ? 1 : 0
  name  = "edd-sim.example.com"
}

module "edd" {
  source = "../.."

  name                            = "eddsim"
  availability_zones              = ["us-east-1a", "us-east-1b"]
  deletion_protection             = false
  dynamodb_point_in_time_recovery = false
  golden_image_repos              = ["node-20"]

  nat_mode = var.nat_mode

  # The sim implements the CloudWatch alarm API (PutMetricAlarm/DescribeAlarms/
  # DeleteAlarms) + EMF extraction (sockerless #607) and the percentile
  # `ExtendedStatistic` round-trip (sockerless #609), so all alarm resources —
  # including the wake-latency p99 alarm — apply + plan idempotently against the sim.
  enable_metric_alarms = true

  # The CloudWatch dashboard API (PutDashboard/GetDashboard/ListDashboards/
  # DeleteDashboards) is implemented as of sockerless #611, so the ops dashboard
  # applies + round-trips against the sim.
  enable_cloudwatch_dashboard = true

  # TLS + workspace-wildcard routing (ACM cert, DNS validation, HTTPS listener).
  domain_name     = var.enable_dns ? "edd-sim.example.com" : ""
  route53_zone_id = var.enable_dns ? aws_route53_zone.test[0].zone_id : ""
}

output "vpc_id" {
  value = module.edd.vpc_id
}

output "dynamodb_table_name" {
  value = module.edd.dynamodb_table_name
}

output "dynamodb_table_arn" {
  value = module.edd.dynamodb_table_arn
}

output "kms_key_arn" {
  value = module.edd.kms_key_arn
}

output "ecs_cluster_name" {
  value = module.edd.ecs_cluster_name
}

output "ecs_cluster_arn" {
  value = module.edd.ecs_cluster_arn
}

output "alb_dns_name" {
  value = module.edd.alb_dns_name
}

output "control_plane_url" {
  value = module.edd.control_plane_url
}

output "control_plane_task_role_arn" {
  value = module.edd.control_plane_task_role_arn
}

output "reconciler_task_role_arn" {
  value = module.edd.reconciler_task_role_arn
}

output "alb_security_group_id" {
  value = module.edd.alb_security_group_id
}

output "tasks_security_group_id" {
  value = module.edd.tasks_security_group_id
}

output "nat_instance_eni_id" {
  value = module.edd.nat_instance_eni_id
}
