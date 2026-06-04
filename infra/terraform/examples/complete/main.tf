# SPDX-License-Identifier: AGPL-3.0-or-later
# Complete example: a production-shaped instantiation of the ecs-dev-desktop
# platform module. Supply your own account (via provider/credentials), region,
# AZs, and — for TLS + workspace routing — a domain and its Route53 zone.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      "edd:env" = var.environment
    }
  }
}

module "ecs_dev_desktop" {
  source = "../../modules/ecs-dev-desktop"

  name               = "edd-${var.environment}"
  availability_zones = var.availability_zones
  single_nat_gateway = var.environment != "prod"

  # Curated golden base images users launch workspaces from.
  golden_image_repos = ["node-20", "go-1.22", "python-3.12"]

  # DNS + TLS + `*.devbox.<domain>` workspace routing (omit for an HTTP-only dev stack).
  domain_name     = var.domain_name
  route53_zone_id = var.route53_zone_id

  # Auth secrets live in Secrets Manager; the module grants the task read access
  # and injects them as env vars. Create the secrets out-of-band (see README).
  secret_environment = var.auth_secret_arns

  tags = {
    "edd:env"   = var.environment
    "ManagedBy" = "terraform"
  }
}
