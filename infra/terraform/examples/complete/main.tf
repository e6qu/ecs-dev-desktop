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

  # Cost-optimized fck-nat NAT instance for dev; managed NAT Gateway(s) for prod.
  nat_mode           = var.environment == "prod" ? "gateway" : "instance"
  single_nat_gateway = var.environment != "prod"

  # Build mode: "local" makes this a true one-apply self-bootstrap — terraform runs
  # scripts/publish-images.sh during apply (docker + source checkout required). Use
  # "pre-published" if your CI already pushes images (e.g. the release workflow), or
  # "codebuild" to build in AWS (no local docker). See the module README.
  image_build_mode = "local"
  image_tag        = var.image_tag

  # Curated golden base images users launch workspaces from. These must match the
  # variant folder names under infra/images/ (omnibus, typescript, python, go, java, rust).
  golden_image_repos = ["omnibus", "typescript"]

  # Seed a default catalog entry so users can create workspaces immediately.
  seed_default_catalog = true

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

  tags = {
    "edd:env"   = var.environment
    "ManagedBy" = "terraform"
  }
}
