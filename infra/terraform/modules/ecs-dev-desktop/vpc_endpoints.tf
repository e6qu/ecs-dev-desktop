# SPDX-License-Identifier: AGPL-3.0-or-later
# Gateway VPC endpoints for S3 and DynamoDB.
#
# Gateway endpoints (unlike interface endpoints) are FREE — no hourly charge and no per-GB data
# processing — and they route traffic to the service directly over the AWS backbone instead of out
# through the NAT instance. Attaching them to the private route tables (where the control plane,
# reconciler, and workspace tasks egress) means:
#   * DynamoDB calls (the single-table control-plane store — read on every request/heartbeat) no
#     longer traverse NAT.
#   * S3 traffic bypasses NAT — the big win is ECR image-layer pulls: ECR stores layers in S3, so
#     the multi-GB golden-image pulls on every workspace cold-start stop paying NAT data-processing.
# AWS injects a managed-prefix-list route into each associated route table automatically; nothing
# in the application changes (the SDK keeps using the regional endpoints). No security-group change
# is needed — a gateway endpoint is a routing target, not an ENI, so the existing egress rules apply.
# The default (full-access) endpoint policy is used; IAM task roles + security groups still govern
# what each task may actually do.

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id
  tags              = merge(local.tags, { Name = "${var.name}-s3-gw" })
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id
  tags              = merge(local.tags, { Name = "${var.name}-dynamodb-gw" })
}
