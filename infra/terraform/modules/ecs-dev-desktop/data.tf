# SPDX-License-Identifier: AGPL-3.0-or-later
# Stateful data layer: the DynamoDB single-table store and a KMS key used to
# encrypt the table, EBS workspace volumes/snapshots, logs, and secrets.

resource "aws_kms_key" "this" {
  description             = "${var.name} ecs-dev-desktop encryption (DynamoDB, EBS, logs, secrets)."
  deletion_window_in_days = 14
  enable_key_rotation     = true
  tags                    = merge(local.tags, { Name = "${var.name}-kms" })
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}-ecs-dev-desktop"
  target_key_id = aws_kms_key.this.key_id
}

# Pre-published mode: resolve the image digest so a new push with the same tag
# still rolls the ECS task definition (digest change = terraform diff).
# In local/codebuild modes these are unused (the build runs during apply).
data "aws_ecr_image" "control_plane" {
  count           = var.image_build_mode == "pre-published" && var.control_plane_image == "" ? 1 : 0
  repository_name = aws_ecr_repository.control_plane.name
  image_tag       = var.image_tag
  registry_id     = local.account_id
}

data "aws_ecr_image" "ssh_gateway" {
  count           = var.image_build_mode == "pre-published" && local.ssh_enabled && var.ssh_gateway_image == "" ? 1 : 0
  repository_name = aws_ecr_repository.ssh_gateway.name
  image_tag       = var.image_tag
  registry_id     = local.account_id
}

locals {
  # The effective image reference passed to ECS. Pre-published + caller didn't
  # override: digest-pinned for auto-roll. Build modes or explicit override: tag-based.
  effective_control_plane_image = (
    var.image_build_mode == "pre-published" && var.control_plane_image == ""
    ? "${data.aws_ecr_image.control_plane[0].image_uri}@${data.aws_ecr_image.control_plane[0].image_digest}"
    : local.control_plane_image
  )
  effective_ssh_gateway_image = (
    local.ssh_enabled
    ? (
      var.image_build_mode == "pre-published" && var.ssh_gateway_image == ""
      ? "${data.aws_ecr_image.ssh_gateway[0].image_uri}@${data.aws_ecr_image.ssh_gateway[0].image_digest}"
      : local.ssh_gateway_image
    )
    : ""
  )
}

# Single-table design — mirrors packages/db/src/table.ts exactly:
#   PK/SK partition + GSI1 (byOwner) + GSI2 (byState), PAY_PER_REQUEST. ElectroDB
#   writes the PK/SK/GSI*PK/GSI*SK attributes; only the key attributes are declared.
resource "aws_dynamodb_table" "this" {
  name         = var.dynamodb_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "GSI1PK"
    type = "S"
  }
  attribute {
    name = "GSI1SK"
    type = "S"
  }
  attribute {
    name = "GSI2PK"
    type = "S"
  }
  attribute {
    name = "GSI2SK"
    type = "S"
  }

  global_secondary_index {
    name = "GSI1"
    key_schema {
      attribute_name = "GSI1PK"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "GSI1SK"
      key_type       = "RANGE"
    }
    projection_type = "ALL"
  }

  global_secondary_index {
    name = "GSI2"
    key_schema {
      attribute_name = "GSI2PK"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "GSI2SK"
      key_type       = "RANGE"
    }
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = var.dynamodb_point_in_time_recovery
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.this.arn
  }

  deletion_protection_enabled = var.deletion_protection

  tags = merge(local.tags, { Name = var.dynamodb_table_name })
}
