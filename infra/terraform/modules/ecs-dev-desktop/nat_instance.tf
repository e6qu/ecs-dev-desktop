# SPDX-License-Identifier: AGPL-3.0-or-later
# Unmanaged NAT via fck-nat (nat_mode = "instance") — a cost-optimized EC2 NAT
# instance, the reputable community alternative to the managed NAT Gateway. It
# runs in the first public subnet, disables source/dest check on its own ENI, and
# (via update_route_tables) points the private subnets' default route at that ENI.
# The dev-desktop tasks remain private-only; only the egress path differs.

module "fck_nat" {
  count = local.managed_network && var.nat_mode == "instance" ? 1 : 0

  source  = "RaJiska/fck-nat/aws"
  version = "~> 1.6"

  name               = "${var.name}-nat"
  vpc_id             = local.vpc_id
  subnet_id          = aws_subnet.public[0].id
  ha_mode            = var.nat_instance_ha
  use_spot_instances = var.nat_instance_use_spot
  instance_type      = var.nat_instance_type

  # Roll the NAT instance to the launch template's latest version on `apply`, so it picks up new
  # fck-nat AMIs (security/OS updates). The AMI family is already pinned by fck-nat to Amazon Linux
  # 2023 (`fck-nat-al2023-hvm-*`, `most_recent = true`), so we track that OS and get its updates
  # without floating across OS families. With auto_rollout=false the instance instead pins
  # `launch_template { version = "$Latest" }`, which the AWS provider records in state as a CONCRETE
  # version number — so any later launch-template version (a new AMI) leaves a standing
  # "$Latest" ≠ "<n>" **replacement diff** that surprises every non-targeted apply. true makes the
  # roll an INTENTIONAL, tracked change: terraform replaces the instance only when the launch template
  # actually changes (verified: consecutive LT versions here are byte-identical, so no per-apply
  # churn), which is a brief NAT-egress blip we accept in exchange for staying patched.
  auto_rollout = true

  # fck-nat owns the private default routes in this mode (0.0.0.0/0 → its ENI).
  update_route_tables = true
  route_tables_ids    = { for i, rt in aws_route_table.private : "private-${i}" => rt.id }
}
