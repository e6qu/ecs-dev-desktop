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
  # ignore_changes on `rule` keeps terraform from reverting them.
  rule {
    name     = "aws-common-rule-set"
    priority = 0

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
