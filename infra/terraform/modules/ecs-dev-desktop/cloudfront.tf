# SPDX-License-Identifier: AGPL-3.0-or-later
# Control-plane scale-to-zero entry. CloudFront fronts `app.<domain>` with an origin
# GROUP: the primary origin is the existing ALB (the control plane, over HTTPS); the
# failover origin is a wake Lambda (a Function URL). When the control-plane ECS
# service is scaled to zero the ALB has no healthy targets and answers 503, so
# CloudFront's origin-group failover (on 502/503/504) routes the request to the wake
# Lambda, which flips the service's desired count back up and returns a "waking"
# response. Steady-state traffic (service > 0) is served by the ALB with no caching
# and full WebSocket pass-through, so the editor proxy (`/w/<id>/`) still works.
#
# Everything here is gated on local.cloudfront_enabled (feature flag AND a domain).
# All CloudFront/ACM(viewer)/WAF-CLOUDFRONT resources use the us-east-1 aliased
# provider — AWS only accepts these global resources there.

locals {
  # Origin ids used across the distribution + origin group.
  cloudfront_alb_origin_id   = "alb-control-plane"
  cloudfront_wake_origin_id  = "wake-lambda"
  cloudfront_origin_group_id = "cp-origin-group"
  cloudfront_failover_status = [502, 503, 504]
  wake_lambda_name           = "${var.name}-wake"
  wake_lambda_log_group_name = "/aws/lambda/${var.name}-wake"
  # The Function URL is `https://<host>/`; a CloudFront custom origin takes only the
  # bare host, so strip the scheme and trailing slash.
  wake_lambda_origin_hostname = local.cloudfront_enabled ? replace(replace(aws_lambda_function_url.wake[0].function_url, "https://", ""), "/", "") : ""
}

# ---- us-east-1 viewer certificate for app.<domain> (CloudFront requires us-east-1) ----
# Separate from the REGIONAL ALB cert in dns.tf: the ALB keeps its own cert (it is the
# CloudFront origin); CloudFront terminates viewer TLS with this us-east-1 cert.

resource "aws_acm_certificate" "cloudfront" {
  count             = local.cloudfront_enabled ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = local.control_plane_fqdn
  validation_method = "DNS"
  tags              = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cloudfront_cert_validation" {
  for_each = local.cloudfront_enabled ? {
    for dvo in aws_acm_certificate.cloudfront[0].domain_validation_options : dvo.domain_name => {
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

resource "aws_acm_certificate_validation" "cloudfront" {
  count                   = local.cloudfront_enabled ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cloudfront[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cloudfront_cert_validation : r.fqdn]
}

# ---- Wake Lambda (@edd/wake-listener) ----
# Built to a zip by `pnpm --filter @edd/wake-listener build` (produces
# packages/wake-listener/dist/wake-listener.zip). The module references the artifact
# through var.wake_lambda_zip so it stays VALID before the artifact exists; the hash
# is computed only when the file is present (fileexists guard) so `terraform validate`
# and a pre-build plan never fail on a missing artifact.

resource "aws_cloudwatch_log_group" "wake" {
  count             = local.cloudfront_enabled ? 1 : 0
  name              = local.wake_lambda_log_group_name
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

data "aws_iam_policy_document" "wake_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# The wake Lambda's ONLY permissions: read + update the control-plane service (to lift
# its desired count off zero) and write its own logs. Nothing else.
data "aws_iam_policy_document" "wake" {
  statement {
    sid       = "WakeControlPlaneService"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = [local.control_plane_service_arn]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    sid       = "WakeLambdaLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:${local.wake_lambda_log_group_name}:*"]
  }
}

resource "aws_iam_role" "wake" {
  count              = local.cloudfront_enabled ? 1 : 0
  name               = "${var.name}-wake"
  assume_role_policy = data.aws_iam_policy_document.wake_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "wake" {
  count  = local.cloudfront_enabled ? 1 : 0
  name   = "${var.name}-wake"
  role   = aws_iam_role.wake[0].id
  policy = data.aws_iam_policy_document.wake.json
}

resource "aws_lambda_function" "wake" {
  count         = local.cloudfront_enabled ? 1 : 0
  function_name = local.wake_lambda_name
  role          = aws_iam_role.wake[0].arn
  runtime       = var.wake_lambda_runtime
  handler       = var.wake_lambda_handler
  timeout       = var.wake_lambda_timeout_seconds
  memory_size   = var.wake_lambda_memory_mb

  filename         = var.wake_lambda_zip
  source_code_hash = fileexists(var.wake_lambda_zip) ? filebase64sha256(var.wake_lambda_zip) : null

  environment {
    variables = {
      ECS_CLUSTER                      = aws_ecs_cluster.this.name
      EDD_CONTROL_PLANE_SERVICE        = "${var.name}-control-plane"
      EDD_CONTROL_PLANE_ACTIVE_DESIRED = tostring(local.control_plane_active_desired)
      EDD_STATUS_URL                   = "https://${local.control_plane_fqdn}/api/readyz"
    }
  }

  tags       = local.tags
  depends_on = [aws_cloudwatch_log_group.wake]
}

# Auth NONE: CloudFront is the only caller (the failover origin), and the wake path
# is a public unauthenticated "the app is waking up" response — no AWS SigV4 in front.
resource "aws_lambda_function_url" "wake" {
  count              = local.cloudfront_enabled ? 1 : 0
  function_name      = aws_lambda_function.wake[0].function_name
  authorization_type = "NONE"
}

# ---- CloudFront distribution ----

resource "aws_cloudfront_distribution" "control_plane" {
  count           = local.cloudfront_enabled ? 1 : 0
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name} control-plane scale-to-zero entry"
  aliases         = [local.control_plane_fqdn]
  price_class     = var.cloudfront_price_class
  web_acl_id      = var.enable_cloudfront_waf ? aws_wafv2_web_acl.cloudfront[0].arn : null
  tags            = local.tags

  # Primary origin: the existing ALB (the running control plane), reached over HTTPS.
  origin {
    origin_id   = local.cloudfront_alb_origin_id
    domain_name = aws_lb.this.dns_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Failover origin: the wake Lambda's Function URL, reached over HTTPS.
  origin {
    origin_id   = local.cloudfront_wake_origin_id
    domain_name = local.wake_lambda_origin_hostname

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Fail over ALB -> wake Lambda on the ECS "no healthy targets" family (502/503/504),
  # exactly the codes the ALB returns when the control-plane service is at zero.
  origin_group {
    origin_id = local.cloudfront_origin_group_id

    failover_criteria {
      status_codes = local.cloudfront_failover_status
    }

    member {
      origin_id = local.cloudfront_alb_origin_id
    }

    member {
      origin_id = local.cloudfront_wake_origin_id
    }
  }

  default_cache_behavior {
    target_origin_id       = local.cloudfront_origin_group_id
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    # All methods so the app's mutations + the editor proxy pass through.
    allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods  = ["GET", "HEAD"]

    # Never cache; forward every header/cookie/query-string so auth + the WebSocket
    # Upgrade/Connection headers reach the ALB untouched.
    cache_policy_id          = local.cloudfront_managed_caching_disabled_policy_id
    origin_request_policy_id = local.cloudfront_managed_all_viewer_orp_id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cloudfront[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
