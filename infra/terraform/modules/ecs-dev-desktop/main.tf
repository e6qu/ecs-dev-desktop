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

  # Default to this stack's own ECR repo at :latest unless the caller pins an image.
  control_plane_image = var.control_plane_image != "" ? var.control_plane_image : "${aws_ecr_repository.control_plane.repository_url}:latest"
  ssh_gateway_image   = var.ssh_gateway_image != "" ? var.ssh_gateway_image : "${aws_ecr_repository.ssh_gateway.repository_url}:latest"
}
