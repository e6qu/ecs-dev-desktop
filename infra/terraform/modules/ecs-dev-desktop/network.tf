# SPDX-License-Identifier: AGPL-3.0-or-later
# VPC with public + private subnets per AZ. The control-plane ALB lives in the
# public subnets; ECS tasks (control plane, workspaces, reconciler) run in the
# private subnets and egress through NAT.

locals {
  az_count = length(var.availability_zones)
  # /20 public + /20 private carved per AZ from the VPC /16.
  public_subnet_cidrs  = [for i in range(local.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  private_subnet_cidrs = [for i in range(local.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  # Managed NAT Gateway(s) only in gateway mode; the fck-nat instance owns egress
  # routing in instance mode (see nat_instance.tf).
  use_managed_nat = var.nat_mode == "gateway"
  nat_count       = local.use_managed_nat ? (var.single_nat_gateway ? 1 : local.az_count) : 0

  # Workspace sshd port (OpenSSH, fixed) — the SG ingress from the control plane.
  workspace_ssh_port = 22
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${var.name}-vpc" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-igw" })
}

resource "aws_subnet" "public" {
  count             = local.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.public_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]
  # Only the ALB and NAT gateways live here; both manage their own public IPs, so
  # subnet auto-assign is unnecessary (and would expose anything else launched here).
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${var.name}-public-${var.availability_zones[count.index]}", Tier = "public" })
}

resource "aws_subnet" "private" {
  count             = local.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]
  tags              = merge(local.tags, { Name = "${var.name}-private-${var.availability_zones[count.index]}", Tier = "private" })
}

resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.name}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count         = local.nat_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(local.tags, { Name = "${var.name}-nat-${count.index}" })
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = merge(local.tags, { Name = "${var.name}-public-rt" })
}

resource "aws_route_table_association" "public" {
  count          = local.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = local.az_count
  vpc_id = aws_vpc.this.id
  # The default route is a separate resource so it can be owned either by the
  # managed NAT gateway (below) or by the fck-nat module (nat_instance.tf).
  tags = merge(local.tags, { Name = "${var.name}-private-rt-${count.index}" })
}

# Default egress route via the managed NAT gateway (gateway mode only).
resource "aws_route" "private_nat" {
  count                  = local.use_managed_nat ? local.az_count : 0
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private" {
  count          = local.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# ---- Security groups ----

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public ingress to the control-plane load balancer."
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP (redirected to HTTPS when TLS is enabled)."
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  count             = local.dns_enabled ? 1 : 0
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS."
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# trivy:ignore:AVD-AWS-0104 The ALB egresses to backend tasks across private subnets; unrestricted egress is standard for an LB.
resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  description       = "Allow all egress."
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "tasks" {
  name        = "${var.name}-tasks"
  description = "Control-plane + reconciler ECS tasks."
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-tasks" })
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "Control-plane port from the ALB only."
  ip_protocol                  = "tcp"
  from_port                    = var.control_plane_port
  to_port                      = var.control_plane_port
  referenced_security_group_id = aws_security_group.alb.id
}

# trivy:ignore:AVD-AWS-0104 Tasks need egress (via NAT) to AWS APIs, Open VSX, and the IdPs; pinning every endpoint CIDR is impractical and brittle.
resource "aws_vpc_security_group_egress_rule" "tasks_all" {
  security_group_id = aws_security_group.tasks.id
  description       = "Allow all egress (NAT to AWS APIs, Open VSX, IdPs)."
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Per-user workspace tasks live in their OWN security group so the editor/sshd ports
# are reachable ONLY from the control plane (which proxies the editor and fronts SSH),
# never workspace-to-workspace. Defence-in-depth alongside the editor connection token
# + registered-key SSH: a workspace cannot reach another workspace's editor or sshd.
resource "aws_security_group" "workspaces" {
  name        = "${var.name}-workspaces"
  description = "Per-user workspace tasks (editor + sshd), reachable only from the control plane."
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-workspaces" })
}

resource "aws_vpc_security_group_ingress_rule" "workspaces_editor_from_control_plane" {
  security_group_id            = aws_security_group.workspaces.id
  description                  = "OpenVSCode editor port from the control plane (in-app proxy) only."
  ip_protocol                  = "tcp"
  from_port                    = var.workspace_port
  to_port                      = var.workspace_port
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_vpc_security_group_ingress_rule" "workspaces_ssh_from_control_plane" {
  security_group_id            = aws_security_group.workspaces.id
  description                  = "sshd from the control plane / SSH gateway only (registered-key auth)."
  ip_protocol                  = "tcp"
  from_port                    = local.workspace_ssh_port
  to_port                      = local.workspace_ssh_port
  referenced_security_group_id = aws_security_group.tasks.id
}

# trivy:ignore:AVD-AWS-0104 Workspaces need egress (via NAT) for image pulls, Open VSX, git, and the control-plane callbacks; pinning every endpoint CIDR is impractical and brittle.
resource "aws_vpc_security_group_egress_rule" "workspaces_all" {
  security_group_id = aws_security_group.workspaces.id
  description       = "Allow all egress (NAT to AWS APIs, Open VSX, git, control-plane)."
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
