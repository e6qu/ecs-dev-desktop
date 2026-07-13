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
# CloudFront reaches the wake Lambda through a PUBLIC API Gateway HTTP API; access is gated by a
# shared-secret custom origin header (x-edd-wake-token) that only CloudFront injects and the handler
# verifies. A Lambda Function URL was tried first (both OAC/AWS_IAM and public/NONE) but every invoke
# returned 403 AccessDeniedException at the URL front door with zero invocations — Function URLs are
# non-functional in this account — while a direct SDK invoke of the same function succeeds, so the
# origin was moved to an API Gateway HTTP API (standard AWS_PROXY invoke path). See BUGS.md.
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
  # Custom origin header CloudFront injects carrying the wake shared secret; the handler requires it
  # (WAKE_TOKEN_HEADER in packages/wake-listener). This is the wake path's whole access control.
  wake_token_header = "x-edd-wake-token"
  # CloudFront reaches the wake Lambda through an API Gateway HTTP API (see below), NOT a Lambda
  # Function URL: Function URLs are non-functional in this account (every invoke — AuthType NONE with a
  # valid public policy AND AWS_IAM with OAC — returns 403 AccessDeniedException at the URL front door
  # with zero invocations, though a direct SDK invoke of the same function succeeds; see BUGS.md). The
  # HTTP API's `$default` stage is served at the bare execute-api host with no stage path.
  wake_api_origin_hostname = local.cloudfront_enabled ? "${aws_apigatewayv2_api.wake[0].id}.execute-api.${local.region}.amazonaws.com" : ""
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
      # Shared secret the handler requires on every request (§ wake gate). CloudFront injects the
      # same value as the x-edd-wake-token origin header (see the wake origin below); a request that
      # did not traverse CloudFront lacks it and is refused with 403 before any ECS call.
      EDD_WAKE_TOKEN = random_password.wake_token[0].result
    }
  }

  tags       = local.tags
  depends_on = [aws_cloudwatch_log_group.wake]
}

# Shared secret gating the wake path. The wake Lambda's front door (the API Gateway HTTP API below) is
# publicly reachable, so access control is this token: CloudFront injects it as the x-edd-wake-token
# custom origin header that only CloudFront knows, and the handler rejects (403) any request whose
# header does not match before making any ECS call. A direct hit on the API therefore can't wake the
# service — and even if it did, the only effect is an idempotent ecs:UpdateService. Rotated on taint.
resource "random_password" "wake_token" {
  count   = local.cloudfront_enabled ? 1 : 0
  length  = 48
  special = false
}

# ---- API Gateway HTTP API in front of the wake Lambda ----
# CloudFront reaches the wake Lambda through this HTTP API, NOT a Lambda Function URL: Function URLs
# are non-functional in this account (see BUGS.md — every Function-URL invoke returns 403
# AccessDeniedException at the URL front door with zero invocations, under BOTH AuthType NONE + a valid
# public resource policy AND AuthType AWS_IAM + OAC, while a direct SDK invoke of the same function
# returns 200). An HTTP API with an AWS_PROXY integration invokes the Lambda over the STANDARD invoke
# path (the one that works), uses the SAME payload-format-2.0 event shape a Function URL does (so the
# handler is unchanged), and is a first-class CloudFront origin. The API is public; the x-edd-wake-token
# gate is its access control (same posture the public Function URL would have had).

resource "aws_apigatewayv2_api" "wake" {
  count         = local.cloudfront_enabled ? 1 : 0
  name          = "${var.name}-wake"
  protocol_type = "HTTP"
  tags          = local.tags
}

resource "aws_apigatewayv2_integration" "wake" {
  count                  = local.cloudfront_enabled ? 1 : 0
  api_id                 = aws_apigatewayv2_api.wake[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.wake[0].arn
  payload_format_version = "2.0"
}

# Catch-all route: CloudFront only ever sends `/_edd_wake*` here (via the ordered behaviour), and the
# handler ignores the path, so a single $default route covers every wake request.
resource "aws_apigatewayv2_route" "wake" {
  count     = local.cloudfront_enabled ? 1 : 0
  api_id    = aws_apigatewayv2_api.wake[0].id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.wake[0].id}"
}

# $default stage with auto-deploy: served at the bare execute-api host (no stage path segment), which
# is what local.wake_api_origin_hostname points CloudFront at.
resource "aws_apigatewayv2_stage" "wake" {
  count       = local.cloudfront_enabled ? 1 : 0
  api_id      = aws_apigatewayv2_api.wake[0].id
  name        = "$default"
  auto_deploy = true
  tags        = local.tags
}

# Allow API Gateway to invoke the wake Lambda, scoped to THIS API's execution ARN. This is the
# standard AWS_PROXY invoke grant (not a Function-URL permission).
resource "aws_lambda_permission" "wake_apigw" {
  count         = local.cloudfront_enabled ? 1 : 0
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.wake[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.wake[0].execution_arn}/*/*"
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

  # Wake origin: the wake Lambda's API Gateway HTTP API ($default stage), reached over HTTPS. Access
  # control is the x-edd-wake-token custom origin header below (the handler rejects any request lacking
  # it). Used by the wake-path behaviour below (NOT an origin-group failover member — CloudFront forbids
  # write methods on an origin-group behaviour, and the app POSTs to page paths via Next.js Server
  # Actions). Function URLs are non-functional in this account, hence API Gateway (see BUGS.md).
  origin {
    origin_id   = local.cloudfront_wake_origin_id
    domain_name = local.wake_api_origin_hostname

    # Shared secret only CloudFront knows: the wake handler requires x-edd-wake-token to equal
    # EDD_WAKE_TOKEN, so a request that did not traverse this distribution can't invoke the wake.
    custom_header {
      name  = local.wake_token_header
      value = random_password.wake_token[0].result
    }

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

    cache_policy_id = local.cloudfront_managed_caching_disabled_policy_id
    # AllViewer-EXCEPT-Host: API Gateway routes on the execute-api Host, so CloudFront must send the
    # API's OWN host — not the viewer Host (app.<domain>), which would fail to match the API. This ORP
    # forwards everything (incl. the x-edd-wake-token origin header) EXCEPT Host, which CloudFront sets
    # to the origin domain itself. The token gate — not Host — is what authorizes the request.
    origin_request_policy_id = local.cloudfront_managed_all_viewer_except_host_orp_id
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
