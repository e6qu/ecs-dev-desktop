# SPDX-License-Identifier: AGPL-3.0-or-later
# DNS + TLS, created only when a domain is provided. A single DNS-validated ACM cert covers the
# control plane (`app.<domain>`); an A alias points it at the ALB. The editor proxy is path-based
# (`app.<domain>/w/<id>/`) folded into the app — there is NO workspace wildcard DNS/TLS.

resource "aws_acm_certificate" "this" {
  count             = local.dns_enabled ? 1 : 0
  domain_name       = local.control_plane_fqdn
  validation_method = "DNS"
  tags              = local.tags

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

# `app.<domain>` A/AAAA alias. When CloudFront fronts the control plane (scale-to-zero
# entry, cloudfront.tf) it points at the DISTRIBUTION; otherwise straight at the ALB.
# Either way the ALB keeps its own DNS name and stays the CloudFront primary origin.
# CloudFront's global zone id is the fixed AWS-published value Z2FDTNDATAQYW2.
locals {
  control_plane_alias_name = local.cloudfront_enabled ? aws_cloudfront_distribution.control_plane[0].domain_name : aws_lb.this.dns_name
  # Route53 alias target zone: CloudFront's fixed global hosted-zone id, else the ALB's.
  control_plane_alias_zone_id = local.cloudfront_enabled ? "Z2FDTNDATAQYW2" : aws_lb.this.zone_id
  # CloudFront evaluates its own health; ALB alias health checks the target group.
  control_plane_alias_eval_health = local.cloudfront_enabled ? false : true
}

resource "aws_route53_record" "control_plane" {
  count   = local.dns_enabled ? 1 : 0
  zone_id = var.route53_zone_id
  name    = local.control_plane_fqdn
  type    = "A"

  alias {
    name                   = local.control_plane_alias_name
    zone_id                = local.control_plane_alias_zone_id
    evaluate_target_health = local.control_plane_alias_eval_health
  }
}

resource "aws_route53_record" "control_plane_aaaa" {
  count   = local.dns_enabled ? 1 : 0
  zone_id = var.route53_zone_id
  name    = local.control_plane_fqdn
  type    = "AAAA"

  alias {
    name                   = local.control_plane_alias_name
    zone_id                = local.control_plane_alias_zone_id
    evaluate_target_health = local.control_plane_alias_eval_health
  }
}
