# SPDX-License-Identifier: AGPL-3.0-or-later
# Terragrunt usage example. Terragrunt supplies the remote state backend and the
# AWS provider, then drives the platform module by inputs alone — so one unit per
# environment (dev/staging/prod) consumes the same module.
#
#   terragrunt init
#   terragrunt plan
#   terragrunt apply

locals {
  environment = "dev"
  region      = "us-east-1"
}

# Pin the module by git ref in real use, e.g.:
#   source = "git::https://github.com/e6qu/ecs-dev-desktop.git//infra/terraform/modules/ecs-dev-desktop?ref=v1.0.0"
terraform {
  source = "${get_repo_root()}/infra/terraform/modules/ecs-dev-desktop"
}

# Remote state in S3 with a DynamoDB lock table (bootstrap these once, out of band).
remote_state {
  backend = "s3"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
  config = {
    bucket         = "edd-tfstate-${local.environment}"
    key            = "ecs-dev-desktop/${local.environment}/terraform.tfstate"
    region         = local.region
    encrypt        = true
    dynamodb_table = "edd-tfstate-locks"
  }
}

# Generate the AWS provider (Terragrunt owns provider config; the module does not).
generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<-EOF
    provider "aws" {
      region = "${local.region}"
      default_tags {
        tags = { "edd:env" = "${local.environment}" }
      }
    }
  EOF
}

inputs = {
  name               = "edd-${local.environment}"
  availability_zones = ["${local.region}a", "${local.region}b"]
  golden_image_repos = ["node-20", "go-1.22"]

  # Egress: a cheap fck-nat NAT instance for dev (use "gateway" + single_nat_gateway for prod).
  nat_mode              = "instance"
  nat_instance_use_spot = true

  # domain_name     = "dev.example.com"
  # route53_zone_id = "Z0123456789ABCDEFGHIJ"
  # secret_environment = { AUTH_SECRET = "arn:aws:secretsmanager:...:secret:edd/auth-secret-AbCdEf" }

  tags = { ManagedBy = "terragrunt" }
}
