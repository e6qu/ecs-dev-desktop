# SPDX-License-Identifier: AGPL-3.0-or-later
# Unmanaged NAT via fck-nat (nat_mode = "instance") — a cost-optimized EC2 NAT
# instance, the reputable community alternative to the managed NAT Gateway. It
# runs in the first public subnet, disables source/dest check on its own ENI, and
# (via update_route_tables) points the private subnets' default route at that ENI.
# The dev-desktop tasks remain private-only; only the egress path differs.

module "fck_nat" {
  count = var.nat_mode == "instance" ? 1 : 0

  source  = "RaJiska/fck-nat/aws"
  version = "~> 1.6"

  name               = "${var.name}-nat"
  vpc_id             = aws_vpc.this.id
  subnet_id          = aws_subnet.public[0].id
  ha_mode            = var.nat_instance_ha
  use_spot_instances = var.nat_instance_use_spot
  instance_type      = var.nat_instance_type

  # fck-nat owns the private default routes in this mode (0.0.0.0/0 → its ENI).
  update_route_tables = true
  route_tables_ids    = { for i, rt in aws_route_table.private : "private-${i}" => rt.id }
}
