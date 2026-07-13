# SPDX-License-Identifier: AGPL-3.0-or-later
# Control-plane scale-to-zero entry. CloudFront fronts `app.<domain>` with a SINGLE ALB origin, so
# steady-state traffic (service > 0) — including the app's Next.js Server-Action POSTs to page paths
# and the WebSocket editor proxy (`/w/<id>/`) — passes straight through with no caching. Scale-from-
# zero is done WITHOUT an origin group (CloudFront forbids write methods on an origin-group
# behaviour): when the control-plane ECS service is at zero the ALB has no healthy target and
# answers 503, and a `custom_error_response` routes that 503 to the wake Lambda (served at
# `/_edd_wake`), which lifts the service's desired count off zero and returns a page that reloads
# until the app is back. See BUGS.md for why the origin-group failover design was abandoned.
#
# Everything here is gated on local.cloudfront_enabled (feature flag AND a domain).
# All CloudFront/ACM(viewer)/WAF-CLOUDFRONT resources use the us-east-1 aliased
# provider — AWS only accepts these global resources there.

locals {
  # Origin ids used across the distribution.
  cloudfront_alb_origin_id  = "alb-control-plane"
  cloudfront_wake_origin_id = "wake-lambda"
  # Dedicated path the wake Lambda serves. The 503 custom_error_response points here (so a browser
  # request that hit the scaled-to-zero ALB is answered by the wake Lambda's reloading page), and it
  # is directly reachable so the reload converges. Underscore-prefixed to never collide with the app.
  cloudfront_wake_path       = "/_edd_wake"
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

  # Cap concurrency: the wake path is public (reached via CloudFront's 503 error handler + the
  # `/_edd_wake` behaviour), so an unbounded cold-start flood could otherwise spawn arbitrarily many
  # concurrent invocations all hammering ECS DescribeServices/UpdateService (shared with workspace
  # lifecycle + the reconciler). Waking is idempotent, so a small ceiling is safe.
  # 0 = no reservation: pass -1 (the provider's "unset" sentinel) so no
  # reserved_concurrent_executions is applied. Required on accounts at AWS's default Lambda
  # concurrency limit of 10, where reserving any amount drops unreserved below its floor of 10.
  reserved_concurrent_executions = var.wake_lambda_reserved_concurrency > 0 ? var.wake_lambda_reserved_concurrency : -1

  filename         = var.wake_lambda_zip
  source_code_hash = fileexists(var.wake_lambda_zip) ? filebase64sha256(var.wake_lambda_zip) : null

  environment {
    variables = {
      ECS_CLUSTER                      = aws_ecs_cluster.this.name
      EDD_CONTROL_PLANE_SERVICE        = "${var.name}-control-plane"
      EDD_CONTROL_PLANE_ACTIVE_DESIRED = tostring(local.control_plane_active_desired)
    }
  }

  tags       = local.tags
  depends_on = [aws_cloudwatch_log_group.wake]
}

# AWS_IAM auth: the Function URL must NOT be world-invokable, or a caller could hit it
# directly and bypass CloudFront + the CLOUDFRONT-scope WAF entirely (rate limit,
# managed rules). CloudFront signs each origin request to this URL with SigV4 via the
# Origin Access Control below, and the aws_lambda_permission grants only the CloudFront
# service principal (scoped to THIS distribution) `lambda:InvokeFunctionUrl`. So the
# only path that can invoke the wake Lambda is a request that already traversed
# CloudFront + WAF.
resource "aws_lambda_function_url" "wake" {
  count              = local.cloudfront_enabled ? 1 : 0
  function_name      = aws_lambda_function.wake[0].function_name
  authorization_type = "AWS_IAM"
}

# Origin Access Control: makes CloudFront SigV4-sign every origin request to the wake
# Lambda Function URL so the AWS_IAM-protected URL accepts it. `origin_type = "lambda"`
# is the Lambda-URL signing mode; `signing_behavior = "always"` signs unconditionally.
# Global CloudFront resource -> us-east-1 provider, like the distribution + web ACL.
resource "aws_cloudfront_origin_access_control" "wake" {
  count                             = local.cloudfront_enabled ? 1 : 0
  provider                          = aws.us_east_1
  name                              = "${var.name}-wake-oac"
  description                       = "SigV4-signs CloudFront origin requests to the ${local.wake_lambda_name} Function URL"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Allow ONLY the CloudFront service principal, scoped to THIS distribution's ARN, to
# invoke the wake Function URL. Combined with AWS_IAM auth + the OAC signing above,
# this is what forces all wake traffic through CloudFront + WAF. Depends on the
# distribution for its ARN (no cycle: the distribution never references this grant).
resource "aws_lambda_permission" "wake_cloudfront" {
  count                  = local.cloudfront_enabled ? 1 : 0
  statement_id           = "AllowCloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.wake[0].function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.control_plane[0].arn
  function_url_auth_type = "AWS_IAM"
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

  # Wake origin: the wake Lambda's Function URL, reached over HTTPS. The OAC makes CloudFront
  # SigV4-sign requests to it so the AWS_IAM-protected URL accepts them. Used by the wake-path
  # behaviour below (NOT an origin-group failover member — CloudFront forbids write methods on an
  # origin-group behaviour, and the app POSTs to page paths via Next.js Server Actions).
  origin {
    origin_id                = local.cloudfront_wake_origin_id
    domain_name              = local.wake_lambda_origin_hostname
    origin_access_control_id = aws_cloudfront_origin_access_control.wake[0].id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Default behaviour: SINGLE ALB origin (no origin group), so ALL methods + the WebSocket editor
  # proxy + Next.js Server-Action POSTs to page paths pass straight through. Scale-from-zero is NOT
  # an origin-group failover (incompatible with write methods) — it is the 503 custom_error_response
  # below, which routes a scaled-to-zero 503 to the wake Lambda.
  default_cache_behavior {
    target_origin_id       = local.cloudfront_alb_origin_id
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods  = ["GET", "HEAD"]

    # Never cache; forward every header/cookie/query-string so auth + the WebSocket
    # Upgrade/Connection headers reach the ALB untouched.
    cache_policy_id          = local.cloudfront_managed_caching_disabled_policy_id
    origin_request_policy_id = local.cloudfront_managed_all_viewer_orp_id
  }

  # Wake path: served by the wake Lambda (triggers ecs:UpdateService + returns the reloading
  # "Starting EDD…" page). This is what the 503 custom_error_response points at, and it is directly
  # reachable so the browser's reload converges. GET/HEAD only (the error handler fetches it as GET).
  ordered_cache_behavior {
    path_pattern           = "${local.cloudfront_wake_path}*"
    target_origin_id       = local.cloudfront_wake_origin_id
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id          = local.cloudfront_managed_caching_disabled_policy_id
    origin_request_policy_id = local.cloudfront_managed_all_viewer_orp_id
  }

  # Scale-from-zero entry: when the control-plane service is at zero the ALB has no healthy target
  # and returns 503; route that to the wake Lambda's page (which triggers the wake). response_code
  # 200 so the browser renders the page; error_caching_min_ttl 0 so it is NEVER cached — every 503
  # re-invokes the wake Lambda (idempotent) and, once the app is back, the ALB's real 200 is served
  # immediately (no stale placeholder). Flood cost is bounded by the CLOUDFRONT WAF rate rule.
  custom_error_response {
    error_code            = 503
    response_code         = 200
    response_page_path    = local.cloudfront_wake_path
    error_caching_min_ttl = 0
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
