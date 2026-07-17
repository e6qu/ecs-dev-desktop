# SPDX-License-Identifier: AGPL-3.0-or-later
# Locals and ambient data sources shared across the module.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  partition  = data.aws_partition.current.partition

  managed_network    = !var.use_existing_vpc
  vpc_id             = local.managed_network ? aws_vpc.this[0].id : var.existing_vpc_id
  public_subnet_ids  = local.managed_network ? aws_subnet.public[*].id : var.existing_public_subnet_ids
  private_subnet_ids = local.managed_network ? aws_subnet.private[*].id : var.existing_private_subnet_ids

  managed_cluster  = !var.use_existing_ecs_cluster
  ecs_cluster_arn  = local.managed_cluster ? aws_ecs_cluster.this[0].arn : var.existing_ecs_cluster_arn
  ecs_cluster_name = local.managed_cluster ? aws_ecs_cluster.this[0].name : var.existing_ecs_cluster_name

  # Per-workspace agent-token secrets the control plane creates at runtime
  # (`edd/workspace/<id>/agent`; Secrets Manager appends a random suffix). The
  # control-plane role manages them and the task execution role reads them for
  # container injection — both scoped to this name prefix, not all secrets.
  workspace_agent_secret_arns = "arn:${data.aws_partition.current.partition}:secretsmanager:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:secret:edd/workspace/*"

  # Every resource carries these for cost allocation, ownership, and GC scoping
  # (the control plane reaps only resources tagged edd:managed = true).
  tags = merge(
    {
      "edd:managed"    = "true"
      "edd:component"  = "ecs-dev-desktop"
      "edd:cost-scope" = var.cost_scope
      "Name"           = var.name
    },
    var.tags,
  )

  dns_enabled = var.domain_name != ""
  # SSH ingress (Slice 3) is independent of the editor domain — it has its own zone.
  ssh_enabled = var.ssh_base_domain != ""

  # CloudFront fronts `app.<domain>` for control-plane scale-to-zero: when the
  # control-plane ECS service is at 0 the ALB origin has no healthy targets and
  # returns 503, so CloudFront fails over to the wake Lambda origin (which scales
  # the service back up). It needs a domain (aliases + a us-east-1 viewer cert), so
  # it is gated on BOTH the feature flag and dns being enabled — an HTTP-only dev
  # stack (no domain) never creates CloudFront even with enable_cloudfront = true.
  cloudfront_enabled = var.enable_cloudfront && local.dns_enabled

  # AWS-managed CloudFront policy IDs. These are GLOBAL, stable, identical in every
  # account in the `aws` partition (they are AWS's own managed policies), so they are
  # referenced by their canonical id rather than looked up per-apply:
  #   Managed-CachingDisabled  — never cache; every request goes to the origin (the
  #     control plane is fully dynamic and proxies editor WebSockets).
  #   Managed-AllViewer        — forward ALL viewer headers, cookies, and query string
  #     to the origin (so auth cookies + the WebSocket Upgrade/Connection headers pass
  #     through untouched). Used for the ALB origin.
  #   Managed-AllViewerExceptHostHeader — same, but does NOT forward the viewer Host. Required for
  #     the wake API Gateway origin: API Gateway routes on the execute-api Host, so CloudFront must send
  #     the API's OWN host, not the viewer host (app.<domain>) which would not match the API. This ORP
  #     forwards everything (incl. the x-edd-wake-token origin header) except Host, which CloudFront
  #     sets to the origin domain. Access is gated by that token, not by Host or IAM.
  # https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html
  cloudfront_managed_caching_disabled_policy_id    = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  cloudfront_managed_all_viewer_orp_id             = "216adef6-5c7f-47e4-b989-5492eafa07d3"
  cloudfront_managed_all_viewer_except_host_orp_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"

  # The wake Lambda flips the control-plane ECS service back to this desired count
  # on the first request that arrives while the service is scaled to zero.
  control_plane_active_desired = var.control_plane_desired_count

  # ARN of the control-plane ECS service, scoped tightly for the wake Lambda + the
  # reconciler's scale-to-zero grant. aws_ecs_service.id is the service ARN in
  # provider v6, but the constructed form keeps the IAM policy readable and avoids a
  # cycle (the wake Lambda's role must not depend on the service that references it).
  control_plane_service_arn = "arn:${local.partition}:ecs:${local.region}:${local.account_id}:service/${local.ecs_cluster_name}/${var.name}-control-plane"

  control_plane_fqdn        = local.dns_enabled ? "app.${var.domain_name}" : null
  github_image_webhook_path = "/api/integrations/github/image-webhook"
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

resource "terraform_data" "shared_infrastructure_contract" {
  input = {
    existing_vpc_id          = var.existing_vpc_id
    use_existing_vpc         = var.use_existing_vpc
    existing_public_subnets  = var.existing_public_subnet_ids
    existing_private_subnets = var.existing_private_subnet_ids
    existing_cluster_arn     = var.existing_ecs_cluster_arn
    existing_cluster_name    = var.existing_ecs_cluster_name
    use_existing_cluster     = var.use_existing_ecs_cluster
  }

  lifecycle {
    precondition {
      condition     = !var.use_existing_vpc || (var.existing_vpc_id != "" && length(var.existing_public_subnet_ids) >= 2 && length(var.existing_private_subnet_ids) >= 2)
      error_message = "use_existing_vpc requires existing_vpc_id and at least two existing public and private subnet IDs."
    }
    precondition {
      condition     = !var.use_existing_ecs_cluster || (var.existing_ecs_cluster_arn != "" && var.existing_ecs_cluster_name != "")
      error_message = "use_existing_ecs_cluster requires existing_ecs_cluster_arn and existing_ecs_cluster_name."
    }
  }
}
