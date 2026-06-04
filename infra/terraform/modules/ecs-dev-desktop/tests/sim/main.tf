# SPDX-License-Identifier: AGPL-3.0-or-later
# Sim-backed test fixture: instantiates the module against the sockerless AWS
# simulator. Per AGENTS.md §6.8 the ONLY difference from real cloud is the
# endpoint (var.sim_endpoint) + dummy credentials — no module branches.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
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
    cloudwatchlogs = var.sim_endpoint
    secretsmanager = var.sim_endpoint
    scheduler      = var.sim_endpoint
    appautoscaling = var.sim_endpoint
    cloudtrail     = var.sim_endpoint
  }
}

module "edd" {
  source = "../.."

  name                            = "eddsim"
  availability_zones              = ["us-east-1a", "us-east-1b"]
  deletion_protection             = false
  dynamodb_point_in_time_recovery = false
  golden_image_repos              = ["node-20"]
}

output "dynamodb_table_name" {
  value = module.edd.dynamodb_table_name
}

output "ecs_cluster_name" {
  value = module.edd.ecs_cluster_name
}

output "control_plane_url" {
  value = module.edd.control_plane_url
}
