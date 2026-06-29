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
  # Allow requesting the account ID so resources that need it (e.g. aws_budgets_budget)
  # can resolve it from STS; the sim returns a deterministic account.
  skip_requesting_account_id = false

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
    budgets        = var.sim_endpoint
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

# Budget toggle. Default 0 (disabled); pass `-var monthly_budget_usd=100` to
# exercise the AWS Budgets resource against the sim (sockerless #703).
variable "monthly_budget_usd" {
  description = "Exercise the module's AWS Budgets guardrail against the sim."
  type        = number
  default     = 0
}

module "edd" {
  source = "../.."

  name                            = "eddsim"
  availability_zones              = ["us-east-1a", "us-east-1b"]
  deletion_protection             = false
  dynamodb_point_in_time_recovery = false
  golden_image_repos              = ["typescript"]

  nat_mode = var.nat_mode

  # The sim fixture does not pre-publish real ECR images; pin explicit dummy image
  # refs so pre-published mode does not try to resolve a non-existent digest.
  image_build_mode    = "pre-published"
  image_tag           = "sim"
  control_plane_image = "eddsim/control-plane:sim"

  # Do not seed the catalog in the sim fixture — keep the table empty for tests.
  seed_default_catalog = false

  # The sim implements the CloudWatch alarm API (PutMetricAlarm/DescribeAlarms/
  # DeleteAlarms) + EMF extraction (sockerless #607) and the percentile
  # `ExtendedStatistic` round-trip (sockerless #609), so all alarm resources —
  # including the wake-latency p99 alarm — apply + plan idempotently against the sim.
  enable_metric_alarms = true

  # The CloudWatch dashboard API (PutDashboard/GetDashboard/ListDashboards/
  # DeleteDashboards) is implemented as of sockerless #611, so the ops dashboard
  # applies + round-trips against the sim.
  enable_cloudwatch_dashboard = true

  # Control-plane TLS routing (ACM cert, DNS validation, HTTPS listener for `app.<domain>`).
  domain_name     = var.enable_dns ? "edd-sim.example.com" : ""
  route53_zone_id = var.enable_dns ? aws_route53_zone.test[0].zone_id : ""

  # SSH ingress (Slice 3): the NLB + TCP:22 listener + target group + gateway service + the
  # `*.<ssh_base_domain>` wildcard — exercised against the sim's ELBv2 `network` LB + Route53. The
  # three NLB/ELBv2 fidelity gaps are all fixed upstream: TCP-TG `Matcher` (#687/#685) +
  # `HealthCheckPath` (#690/#688), and the NLB `DNSName` is now a stable AWS-shaped hostname
  # (#692/#691) so `aws_lb.dns_name` + the Route53 alias settle. Apply + idempotency re-plan are clean.
  # The gateway image is a PINNED tag; the sim only creates the task def, never pulls it.
  ssh_base_domain     = var.enable_dns ? "ssh.edd-sim.example.com" : ""
  route53_ssh_zone_id = var.enable_dns ? aws_route53_zone.test[0].zone_id : ""
  ssh_gateway_image   = var.enable_dns ? "eddsim/ssh-gateway:sim" : ""

  # Exercise AWS Budgets when DNS/TLS is enabled, so the #713 probe suite can
  # validate Budgets service behavior end-to-end through Terraform once
  # sockerless #714 is fixed.
  monthly_budget_usd = var.enable_dns ? 100 : var.monthly_budget_usd
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
