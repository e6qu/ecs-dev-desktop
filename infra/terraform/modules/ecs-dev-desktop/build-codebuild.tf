# SPDX-License-Identifier: AGPL-3.0-or-later
# CodeBuild image build: terraform creates a project and starts a build during
# apply. No docker is required on the operator machine. The build clones the
# configured git repo, logs in to ECR, and runs scripts/publish-images.sh.
# The task definitions depend_on the build trigger so they wait for completion.

locals {
  codebuild_project_name = "${var.name}-build-images"
}

# CodeBuild service role: ECR push, CloudWatch Logs, KMS decrypt for ECR.
data "aws_iam_policy_document" "codebuild_assume" {
  count = local.build_codebuild_enabled ? 1 : 0
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "codebuild" {
  count              = local.build_codebuild_enabled ? 1 : 0
  name               = "${var.name}-codebuild"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume[0].json
  tags               = local.tags
}

resource "aws_iam_role_policy" "codebuild" {
  count = local.build_codebuild_enabled ? 1 : 0
  name  = "ecr-push-and-logs"
  role  = aws_iam_role.codebuild[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ECRAuthToken"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "ECRPushToModuleRepos"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
        ]
        Resource = concat([
          aws_ecr_repository.control_plane.arn,
          aws_ecr_repository.ssh_gateway.arn,
        ], [for repo in aws_ecr_repository.golden : repo.arn])
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/codebuild/${local.codebuild_project_name}:*"
      },
      {
        Sid    = "KMSForECR"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey",
        ]
        Resource = aws_kms_key.this.arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "codebuild" {
  count             = local.build_codebuild_enabled ? 1 : 0
  name              = "/aws/codebuild/${local.codebuild_project_name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
  tags              = local.tags
}

resource "aws_codebuild_project" "build_images" {
  count        = local.build_codebuild_enabled ? 1 : 0
  name         = local.codebuild_project_name
  service_role = aws_iam_role.codebuild[0].arn
  tags         = local.tags

  artifacts {
    type = "NO_ARTIFACTS"
  }

  # Privileged mode is required to run `docker build` / `docker push` inside
  # CodeBuild. The build environment is ephemeral and has no access to secrets
  # beyond the ECR-push role above.
  # trivy:ignore:AVD-AWS-0037
  environment {
    compute_type                = var.codebuild_compute_type
    type                        = "LINUX_CONTAINER"
    image                       = "aws/codebuild/amazonlinux2-x86_64-standard:5.0"
    privileged_mode             = true
    image_pull_credentials_type = "CODEBUILD"
  }

  source {
    type      = "NO_SOURCE"
    buildspec = <<-EOT
      version: 0.2
      env:
        variables:
          AWS_ACCOUNT: ${local.account_id}
          AWS_REGION: ${local.region}
          NAME: ${var.name}
          TAG: ${var.image_tag}
          VARIANTS: ${join(" ", var.golden_image_repos)}
          SOURCE_REPO: ${var.codebuild_source_repo}
          SOURCE_REF: ${var.codebuild_source_ref}
          EDD_BUILD_ARCHS: amd64
      phases:
        pre_build:
          commands:
            - set -eu
            - aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"
            - git clone "$SOURCE_REPO" -b "$SOURCE_REF" repo
            - cd repo
            - corepack enable && corepack prepare pnpm@10.33.3 --activate
            - pnpm install --frozen-lockfile
        build:
          commands:
            - sh scripts/publish-images.sh "$AWS_ACCOUNT" "$AWS_REGION" "$NAME" "$TAG" $VARIANTS
    EOT
  }

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.codebuild[0].name
      status     = "ENABLED"
    }
  }

  depends_on = [
    aws_ecr_repository.control_plane,
    aws_ecr_repository.golden,
    aws_ecr_repository.ssh_gateway,
  ]
}

# Trigger the CodeBuild build and poll until it finishes. A null_resource local-exec
# is the only terraform-native way to "run and wait" for a CodeBuild invocation.
resource "terraform_data" "build_images_codebuild" {
  count = local.build_codebuild_enabled ? 1 : 0

  triggers_replace = [
    var.image_tag,
    var.codebuild_source_ref,
    join(",", var.golden_image_repos),
  ]

  provisioner "local-exec" {
    command = "sh ${path.module}/scripts/wait-codebuild.sh ${aws_codebuild_project.build_images[0].name} ${local.region}"
  }

  depends_on = [aws_codebuild_project.build_images]
}
