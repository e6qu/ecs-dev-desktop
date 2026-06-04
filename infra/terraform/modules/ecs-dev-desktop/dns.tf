# SPDX-License-Identifier: AGPL-3.0-or-later
# DNS + TLS, created only when a domain is provided. A single DNS-validated ACM
# cert covers the control plane (`app.<domain>`) and the workspace wildcard
# (`*.<workspaces_subdomain>.<domain>`); A/AAAA aliases point both at the ALB.

resource "aws_acm_certificate" "this" {
  count                     = local.dns_enabled ? 1 : 0
  domain_name               = local.control_plane_fqdn
  subject_alternative_names = [local.workspaces_fqdn]
  validation_method         = "DNS"
  tags                      = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.dns_enabled ? {
    for dvo in aws_acm_certificate.this[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  count                   = local.dns_enabled ? 1 : 0
  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "control_plane" {
  count   = local.dns_enabled ? 1 : 0
  zone_id = var.route53_zone_id
  name    = local.control_plane_fqdn
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "workspaces_wildcard" {
  count   = local.dns_enabled ? 1 : 0
  zone_id = var.route53_zone_id
  name    = local.workspaces_fqdn
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
