# SPDX-License-Identifier: AGPL-3.0-or-later
# Admin-managed CLOUDFRONT-scope WAF for the scale-to-zero entry (cloudfront.tf).
# This is SEPARATE from the REGIONAL ALB WAF in waf.tf (which stays as-is and guards
# the ALB's webhook path): CLOUDFRONT-scope resources are global and only accepted in
# us-east-1, so they use the aws.us_east_1 aliased provider.
#
# Terraform seeds a minimal managed baseline (the AWS common rule set) and then GETS
# OUT OF THE WAY: the control plane manages the live admin rule set + the admin CIDR
# allow/deny IP set through the WAFv2 API at runtime. `lifecycle { ignore_changes }`
# on `rule` (web ACL) and `addresses` (IP set) means a normal `terraform apply` never
# clobbers what the app has applied. Bootstrap-then-hand-off, versioned by the app.

locals {
  cloudfront_waf_enabled = local.cloudfront_enabled && var.enable_cloudfront_waf

  # Fixed low-priority band for the Terraform-seeded baseline rules (lower number =
  # evaluated first). The common rule set runs first, then the rate-based guard. The
  # control plane owns every rule ABOVE this band (higher priority numbers) via
  # UpdateWebACL at runtime; ignore_changes on `rule` keeps terraform off them.
  cloudfront_waf_common_priority     = 0
  cloudfront_waf_rate_limit_priority = 1
}

resource "aws_wafv2_web_acl" "cloudfront" {
  count       = local.cloudfront_waf_enabled ? 1 : 0
  provider    = aws.us_east_1
  name        = "${var.name}-cloudfront"
  description = "Admin-managed CloudFront edge WAF for ${local.control_plane_fqdn}"
  scope       = "CLOUDFRONT"
  tags        = local.tags

  default_action {
    allow {}
  }

  # Seed only: a baseline managed rule group so the ACL is protective from the first
  # apply. The control plane adds/edits admin rules through UpdateWebACL at runtime;
  # ignore_changes on `rule` keeps terraform from reverting them. Both seeded rules
  # sit in a FIXED LOW-priority band (0-1); the app owns the higher-priority band.
  rule {
    name     = "aws-common-rule-set"
    priority = local.cloudfront_waf_common_priority

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-cloudfront-common"
      sampled_requests_enabled   = true
    }
  }

  # Volumetric L7 guard the common rule set does NOT provide: block any source IP
  # that exceeds cloudfront_rate_limit requests over WAF's rolling 5-minute window.
  # COST + availability protection: the Web ACL is evaluated at the CloudFront edge on
  # the VIEWER request, BEFORE origin selection / origin-group failover, so a blocked
  # request returns 403 at the edge and NEVER reaches the ALB or fails over to the wake
  # Lambda. That means a rate-limited flood triggers no scale-from-zero and no wake
  # Lambda invocation — no per-invoke/GB-s Lambda bill and no ECS-API pressure from the
  # flood. Priority ABOVE the common rule set; still in the seeded low band so the
  # app-owned rules sit above both.
  rule {
    name     = "rate-limit-per-ip"
    priority = local.cloudfront_waf_rate_limit_priority

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = var.cloudfront_rate_limit
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-cloudfront-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-cloudfront"
    sampled_requests_enabled   = true
  }

  # The control plane owns the live rule set (UpdateWebACL) after bootstrap.
  lifecycle {
    ignore_changes = [rule]
  }
}

# Empty admin CIDR IP set the control plane populates (UpdateIPSet) — e.g. an admin
# allow-list or a block-list the WAF rules reference. Terraform creates it empty and
# never touches its addresses again.
resource "aws_wafv2_ip_set" "cloudfront_admin" {
  count              = local.cloudfront_waf_enabled ? 1 : 0
  provider           = aws.us_east_1
  name               = "${var.name}-cloudfront-admin"
  description        = "Admin-managed CIDR list for the CloudFront WAF (populated by the control plane)"
  scope              = "CLOUDFRONT"
  ip_address_version = "IPV4"
  addresses          = []
  tags               = local.tags

  lifecycle {
    ignore_changes = [addresses]
  }
}
