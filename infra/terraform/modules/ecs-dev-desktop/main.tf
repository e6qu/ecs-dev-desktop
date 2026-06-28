# SPDX-License-Identifier: AGPL-3.0-or-later
# Locals and ambient data sources shared across the module.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  partition  = data.aws_partition.current.partition

  # Per-workspace agent-token secrets the control plane creates at runtime
  # (`edd/workspace/<id>/agent`; Secrets Manager appends a random suffix). The
  # control-plane role manages them and the task execution role reads them for
  # container injection — both scoped to this name prefix, not all secrets.
  workspace_agent_secret_arns = "arn:${data.aws_partition.current.partition}:secretsmanager:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:secret:edd/workspace/*"

  # Every resource carries these for cost allocation, ownership, and GC scoping
  # (the control plane reaps only resources tagged edd:managed = true).
  tags = merge(
    {
      "edd:managed"   = "true"
      "edd:component" = "ecs-dev-desktop"
      "Name"          = var.name
    },
    var.tags,
  )

  dns_enabled = var.domain_name != ""
  # SSH ingress (Slice 3) is independent of the editor domain — it has its own zone.
  ssh_enabled = var.ssh_base_domain != ""

  control_plane_fqdn = local.dns_enabled ? "app.${var.domain_name}" : null
  # `*.<ssh_base_domain>` — every workspace is reached at `<ws-id>.<ssh_base_domain>`.
  ssh_wildcard_fqdn = local.ssh_enabled ? "*.${var.ssh_base_domain}" : null

  # Default to this stack's own ECR repo at the configured tag unless the caller
  # pins an image. In local/codebuild modes the build resources push to this tag
  # during apply; in pre-published mode terraform resolves the digest for auto-roll.
  control_plane_image_default = "${aws_ecr_repository.control_plane.repository_url}:${var.image_tag}"
  control_plane_image         = var.control_plane_image != "" ? var.control_plane_image : local.control_plane_image_default

  # The SSH gateway has no `:latest` fallback — in build modes we compute the
  # pinned tag from the ECR repo; in pre-published mode the caller must supply it
  # (or it also defaults to the repo tag, resolved by digest).
  ssh_gateway_image_default = "${aws_ecr_repository.ssh_gateway.repository_url}:${var.image_tag}"
  ssh_gateway_image = (
    var.ssh_gateway_image != "" ? var.ssh_gateway_image :
    local.ssh_enabled ? local.ssh_gateway_image_default : ""
  )

  build_local_enabled     = var.image_build_mode == "local"
  build_codebuild_enabled = var.image_build_mode == "codebuild"

  # Default golden catalog entry uses the first requested variant if the chosen
  # one isn't present, falling back to omnibus if nothing else is configured.
  seed_variant = contains(var.golden_image_repos, var.seed_catalog_variant) ? var.seed_catalog_variant : (
    length(var.golden_image_repos) > 0 ? var.golden_image_repos[0] : ""
  )
  seed_image_ref = local.seed_variant != "" ? "${local.account_id}.dkr.ecr.${local.region}.amazonaws.com/${var.name}/golden/${local.seed_variant}:${var.image_tag}" : ""
}
