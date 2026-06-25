# SPDX-License-Identifier: AGPL-3.0-or-later
# SSH ingress (Slice 3): the public SSH front door. A network LB with a raw TCP:22 listener forwards
# to the SSH-gateway service (OpenSSH proxy, registered-key dual-trust via the control plane's
# `ssh-authorize`), which in turn reaches each workspace's sshd. A `*.<ssh_base_domain>` wildcard
# points at the NLB, so a workspace is reached as `ssh <principal>@<ws-id>.<ssh_base_domain>`.
#
# Gated on `ssh_base_domain` (empty = no SSH ingress) and independent of the editor `domain_name`.
# The ECR repo + log group are created unconditionally (cheap, and keep `local.ssh_gateway_image`
# resolvable); the NLB / listener / target group / service / DNS are created only when enabled.

resource "aws_ecr_repository" "ssh_gateway" {
  name                 = "${var.name}/ssh-gateway"
  image_tag_mutability = "MUTABLE" # rolling deploy tag (:latest)
  force_delete         = !var.deletion_protection
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.this.arn
  }
  tags = merge(local.tags, { Name = "${var.name}-ssh-gateway" })
}

resource "aws_ecr_lifecycle_policy" "ssh_gateway" {
  repository = aws_ecr_repository.ssh_gateway.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged images after 14 days"
      selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 14 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "ssh_gateway" {
  name              = "/ecs/${var.name}/ssh-gateway"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
  tags              = local.tags
}

# Public SSH ingress security group: the gateway accepts 22/tcp from the internet (the NLB preserves
# the client source IP). Workspaces accept sshd only from this SG (the rule below).
resource "aws_security_group" "ssh_gateway" {
  name        = "${var.name}-ssh-gateway"
  description = "SSH gateway tasks — public 22/tcp ingress, all egress (reach control-plane + workspaces)."
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-ssh-gateway" })
}

# trivy:ignore:AVD-AWS-0107 Public SSH ingress is the intended front door; auth is registered-key dual-trust at the gateway.
resource "aws_vpc_security_group_ingress_rule" "ssh_gateway_public" {
  security_group_id = aws_security_group.ssh_gateway.id
  description       = "Public SSH (registered-key dual-trust auth at the gateway)."
  ip_protocol       = "tcp"
  from_port         = local.workspace_ssh_port
  to_port           = local.workspace_ssh_port
  cidr_ipv4         = "0.0.0.0/0"
}

# trivy:ignore:AVD-AWS-0104 The gateway needs egress to the control plane (ssh-authorize) + workspace sshd; pinning CIDRs is brittle.
resource "aws_vpc_security_group_egress_rule" "ssh_gateway_all" {
  security_group_id = aws_security_group.ssh_gateway.id
  description       = "Allow all egress (control-plane ssh-authorize + workspace sshd)."
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Workspaces also accept sshd from the gateway SG (in addition to the control-plane SG).
resource "aws_vpc_security_group_ingress_rule" "workspaces_ssh_from_gateway" {
  count                        = local.ssh_enabled ? 1 : 0
  security_group_id            = aws_security_group.workspaces.id
  description                  = "sshd from the SSH gateway."
  ip_protocol                  = "tcp"
  from_port                    = local.workspace_ssh_port
  to_port                      = local.workspace_ssh_port
  referenced_security_group_id = aws_security_group.ssh_gateway.id
}

# trivy:ignore:AVD-AWS-0053 The SSH NLB is the platform's public SSH front door — internet-facing is intended.
resource "aws_lb" "ssh" {
  count                      = local.ssh_enabled ? 1 : 0
  name                       = "${var.name}-ssh"
  load_balancer_type         = "network"
  subnets                    = aws_subnet.public[*].id
  enable_deletion_protection = var.deletion_protection
  tags                       = local.tags
}

resource "aws_lb_target_group" "ssh_gateway" {
  count       = local.ssh_enabled ? 1 : 0
  name        = "${var.name}-ssh"
  port        = local.workspace_ssh_port
  protocol    = "TCP"
  vpc_id      = aws_vpc.this.id
  target_type = "ip"

  health_check {
    protocol            = "TCP"
    healthy_threshold   = 2
    unhealthy_threshold = 2
    interval            = 30
  }

  tags = local.tags
}

resource "aws_lb_listener" "ssh" {
  count             = local.ssh_enabled ? 1 : 0
  load_balancer_arn = aws_lb.ssh[0].arn
  port              = local.workspace_ssh_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ssh_gateway[0].arn
  }
}

resource "aws_ecs_task_definition" "ssh_gateway" {
  count                    = local.ssh_enabled ? 1 : 0
  family                   = "${var.name}-ssh-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.ssh_gateway_cpu)
  memory                   = tostring(var.ssh_gateway_memory)
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name      = "ssh-gateway"
    image     = local.ssh_gateway_image
    essential = true
    portMappings = [{
      containerPort = local.workspace_ssh_port
      protocol      = "tcp"
    }]
    environment = [
      { name = "EDD_SSH_BASE_DOMAIN", value = var.ssh_base_domain },
      { name = "EDD_CONTROL_PLANE_URL", value = local.dns_enabled ? "https://${local.control_plane_fqdn}" : "http://${aws_lb.this.dns_name}" },
    ]
    # The gateway derives the per-workspace machine token from EDD_GATEWAY_SECRET (shared with the
    # control plane); inject it from Secrets Manager when the caller wired it.
    secrets = [for k, arn in var.secret_environment : { name = k, valueFrom = arn } if k == "EDD_GATEWAY_SECRET"]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ssh_gateway.name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = "ssh"
      }
    }
  }])

  tags = local.tags
}

resource "aws_ecs_service" "ssh_gateway" {
  count           = local.ssh_enabled ? 1 : 0
  name            = "${var.name}-ssh-gateway"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.ssh_gateway[0].arn
  desired_count   = var.ssh_gateway_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ssh_gateway.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.ssh_gateway[0].arn
    container_name   = "ssh-gateway"
    container_port   = local.workspace_ssh_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.ssh]
  tags       = local.tags
}

resource "aws_route53_record" "ssh_wildcard" {
  count   = local.ssh_enabled ? 1 : 0
  zone_id = var.route53_ssh_zone_id
  name    = local.ssh_wildcard_fqdn
  type    = "A"

  alias {
    name                   = aws_lb.ssh[0].dns_name
    zone_id                = aws_lb.ssh[0].zone_id
    evaluate_target_health = true
  }
}
