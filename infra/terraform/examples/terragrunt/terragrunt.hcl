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

# Generate the AWS providers (Terragrunt owns provider config; the module does not).
# The module requires an `aws.us_east_1` aliased provider for the global CloudFront /
# viewer-cert / CLOUDFRONT-WAF resources (the scale-to-zero entry), so we generate BOTH
# the regional provider and the pinned us-east-1 one. This is required even with
# enable_cloudfront off — configuration_aliases is a static module requirement.
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

    provider "aws" {
      alias  = "us_east_1"
      region = "us-east-1"
      default_tags {
        tags = { "edd:env" = "${local.environment}" }
      }
    }
  EOF
}

inputs = {
  name               = "edd-${local.environment}"
  availability_zones = ["${local.region}a", "${local.region}b"]

  # Egress: a cheap fck-nat NAT instance for dev (use "gateway" + single_nat_gateway for prod).
  nat_mode              = "instance"
  nat_instance_use_spot = true

  # One-apply self-bootstrap: terraform builds and pushes the images during apply.
  # Use "pre-published" if your CI already pushes images, or "codebuild" to build
  # in AWS (set codebuild_source_repo). See the module README.
  image_build_mode = "local"
  image_tag        = get_env("EDD_IMAGE_TAG")

  # Curated golden base images. Must match the variant folder names under infra/images/.
  golden_image_repos = ["omnibus"]

  # Seed a default catalog entry so users can create workspaces immediately.
  seed_default_catalog = true

  # domain_name     = "dev.example.com"
  # route53_zone_id = "Z0123456789ABCDEFGHIJ"

  # Public SSH front door (independent of the editor domain). In "local" build
  # mode the gateway image is built/pushed automatically; otherwise set
  # ssh_gateway_image to a pinned tag.
  # ssh_base_domain     = "ssh.dev.example.com"
  # route53_ssh_zone_id = "Z0123456789ABCDEFGHIJ"
  # ssh_gateway_image   = "<account>.dkr.ecr.${local.region}.amazonaws.com/edd-dev/ssh-gateway:0123456789ab"

  # secret_environment = { AUTH_SECRET = "arn:aws:secretsmanager:...:secret:edd/auth-secret-AbCdEf" }
  # extra_environment  = { EDD_ADMIN_GROUPS = "platform-admins", AUTH_TRUST_HOST = "true" }

  tags = { ManagedBy = "terragrunt" }
}
