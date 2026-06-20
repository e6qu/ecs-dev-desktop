# SPDX-License-Identifier: AGPL-3.0-or-later
# Application Load Balancer fronting the control plane. HTTP→HTTPS redirect plus
# an HTTPS listener when TLS is enabled (a domain is set); HTTP-only otherwise
# (dev). The control-plane app serves everything behind this listener, including
# the in-app browser→VS Code workspace proxy (`/w/<id>/`).

# trivy:ignore:AVD-AWS-0053 This ALB is the platform's public front door — internet-facing is intended.
resource "aws_lb" "this" {
  name                       = "${var.name}-cp"
  load_balancer_type         = "application"
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  tags                       = local.tags
}

resource "aws_lb_target_group" "control_plane" {
  name        = "${var.name}-cp"
  port        = var.control_plane_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.this.id
  target_type = "ip"

  # Readiness (not liveness): a task whose DynamoDB is unreachable is pulled from
  # the LB but left running for the ECS container healthcheck (/api/healthz) to
  # decide whether to restart it. /api/readyz returns 503 when not ready.
  health_check {
    path                = "/api/readyz"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
  }

  tags = local.tags
}

# HTTP listener: redirect to HTTPS when TLS is on, otherwise forward (dev).
# trivy:ignore:AVD-AWS-0054 Port 80 redirects to HTTPS when a domain is set; HTTP-only forwarding is the dev (no-TLS) path.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = local.dns_enabled ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  dynamic "default_action" {
    for_each = local.dns_enabled ? [] : [1]
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.control_plane.arn
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = local.dns_enabled ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.this[0].arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.control_plane.arn
  }
}
