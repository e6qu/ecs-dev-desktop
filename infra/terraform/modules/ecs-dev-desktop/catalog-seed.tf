# SPDX-License-Identifier: AGPL-3.0-or-later
# Seed a default base-image catalog entry in the DynamoDB single-table store so
# users can launch workspaces immediately after a one-shot apply. The item shape
# matches the ElectroDB baseImage entity (packages/db/src/entities.ts). Safe to
# re-apply because `aws_dynamodb_table_item` is managed state.

locals {
  seed_id        = "img-seed-${local.seed_variant}"
  seed_created   = "1970-01-01T00:00:00.000Z"
  seed_tags_str  = join(",", var.seed_catalog_tags)
  seed_tools_str = join(",", var.seed_catalog_tools)
}

resource "aws_dynamodb_table_item" "default_catalog" {
  count      = var.seed_default_catalog && local.seed_variant != "" ? 1 : 0
  table_name = aws_dynamodb_table.this.name
  hash_key   = "PK"
  range_key  = "SK"

  item = jsonencode({
    id          = { S = local.seed_id }
    name        = { S = var.seed_catalog_name }
    image       = { S = local.seed_image_ref }
    description = { S = var.seed_catalog_description }
    tags        = { L = [for t in var.seed_catalog_tags : { S = t }] }
    tools       = { L = [for t in var.seed_catalog_tools : { S = t }] }
    enabled     = { BOOL = true }
    editor      = { S = "openvscode" }
    createdAt   = { S = local.seed_created }
    version     = { N = "0" }
    PK          = { S = "$edd#id_${local.seed_id}" }
    SK          = { S = "$baseimage_1" }
    GSI1PK      = { S = "$edd" }
    GSI1SK      = { S = "$baseimage_1#createdat_${lower(local.seed_created)}#id_${local.seed_id}" }
    __edb_e__   = { S = "baseImage" }
    __edb_v__   = { S = "1" }
  })

  lifecycle {
    ignore_changes = [
      # Once the admin edits the catalog in the UI, don't fight those changes on
      # the next apply. The seed is only meant to create the row if absent.
      item,
    ]
  }

  depends_on = [aws_dynamodb_table.this]
}
