# SPDX-License-Identifier: AGPL-3.0-or-later
# ECR repositories: one for the control-plane app image, and one per curated
# golden base image users launch workspaces from. Scan-on-push + a lifecycle
# policy that keeps the most recent N images.

locals {
  ecr_lifecycle_policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire all but the ${var.image_retention_count} most recent images."
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.image_retention_count
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_repository" "control_plane" {
  name                 = "${var.name}/control-plane"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = !var.deletion_protection

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.this.arn
  }

  tags = merge(local.tags, { Name = "${var.name}-control-plane" })
}

resource "aws_ecr_lifecycle_policy" "control_plane" {
  repository = aws_ecr_repository.control_plane.name
  policy     = local.ecr_lifecycle_policy
}

resource "aws_ecr_repository" "golden_base" {
  name                 = "${var.name}/edd-base"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = !var.deletion_protection

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.this.arn
  }

  tags = merge(local.tags, { Name = "${var.name}-golden-base" })
}

resource "aws_ecr_lifecycle_policy" "golden_base" {
  repository = aws_ecr_repository.golden_base.name
  policy     = local.ecr_lifecycle_policy
}

resource "aws_ecr_repository" "golden" {
  for_each             = toset(var.golden_image_repos)
  name                 = "${var.name}/golden/${each.value}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = !var.deletion_protection

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.this.arn
  }

  tags = merge(local.tags, { Name = "${var.name}-golden-${each.value}" })
}

resource "aws_ecr_lifecycle_policy" "golden" {
  for_each   = aws_ecr_repository.golden
  repository = each.value.name
  policy     = local.ecr_lifecycle_policy
}
