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
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "GSI2"
    hash_key        = "GSI2PK"
    range_key       = "GSI2SK"
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
