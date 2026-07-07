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

  # Private-subnet egress. Explicit var — do NOT derive from var.environment's name
  # (a stack happening to be named "...-prod" must not silently switch NAT modes).
  nat_mode           = var.nat_mode
  single_nat_gateway = var.single_nat_gateway
  nat_instance_type  = var.nat_instance_type

  # Build mode: "local" makes this a true one-apply self-bootstrap — terraform runs
  # scripts/publish-images.sh during apply (docker + source checkout required). Use
  # "pre-published" if your CI already pushes images (e.g. the release workflow), or
  # "codebuild" to build in AWS (no local docker; requires codebuild_source_repo). See
  # the module README.
  image_build_mode      = var.image_build_mode
  image_tag             = var.image_tag
  codebuild_source_repo = var.codebuild_source_repo
  codebuild_source_ref  = var.codebuild_source_ref
  build_target          = var.build_target

  # Curated golden base images users launch workspaces from. These must match the
  # variant folder names under infra/images/ (omnibus, typescript, python, go, java, rust).
  golden_image_repos = var.golden_image_repos

  # Seed a default catalog entry so users can create workspaces immediately.
  seed_default_catalog = var.seed_default_catalog

  # DNS + a single-host ACM cert for the path-based editor proxy (`app.<domain>/w/<id>/`) — no
  # wildcard DNS/TLS (omit this whole block for an HTTP-only dev stack).
  domain_name     = var.domain_name
  route53_zone_id = var.route53_zone_id

  # Public SSH front door (NLB + `*.<ssh_base_domain>` wildcard). Independent of the editor
  # domain above; leave ssh_base_domain empty to skip SSH ingress. In "local" build mode the
  # gateway image is built/pushed automatically; otherwise set ssh_gateway_image to a pinned tag.
  ssh_base_domain     = var.ssh_base_domain
  route53_ssh_zone_id = var.route53_ssh_zone_id
  ssh_gateway_image   = var.ssh_gateway_image

  # Secrets (auth + crypto) live in Secrets Manager; the module grants the task read
  # access and injects them as env vars. Create the secrets out-of-band (see
  # docs/deploying.md, or scripts/bootstrap-secrets.sh). Non-secret config (RBAC groups,
  # AUTH_TRUST_HOST, Entra issuer) goes through extra_environment.
  secret_environment = var.auth_secret_arns
  extra_environment  = var.extra_environment

  # Optional cost guardrail + alarm notifications (disabled by default — 0 / empty
  # matches the module's own defaults).
  monthly_budget_usd   = var.monthly_budget_usd
  alarm_sns_topic_arns = var.alarm_sns_topic_arns

  tags = {
    "edd:env"   = var.environment
    "ManagedBy" = "terraform"
  }
}
