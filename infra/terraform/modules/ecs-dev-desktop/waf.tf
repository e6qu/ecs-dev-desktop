# SPDX-License-Identifier: AGPL-3.0-or-later
# Public-surface guard for the only unauthenticated integration route. The ALB
# must remain internet-facing for the app itself, but the GitHub image webhook
# path is narrowed at WAF before the request reaches Next.js. HMAC verification
# and the exact body-size cap still live in the app; WAF handles cheap edge
# rejection and rate limiting.

resource "aws_wafv2_web_acl" "control_plane" {
  name        = "${var.name}-control-plane"
  description = "Control-plane public surface guard"
  scope       = "REGIONAL"
  tags        = local.tags

  default_action {
    allow {}
  }

  rule {
    name     = "github-image-webhook-post-only"
    priority = 10

    action {
      block {}
    }

    statement {
      and_statement {
        statement {
          byte_match_statement {
            search_string         = local.github_image_webhook_path
            positional_constraint = "EXACTLY"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }

        statement {
          not_statement {
            statement {
              byte_match_statement {
                search_string         = "POST"
                positional_constraint = "EXACTLY"

                field_to_match {
                  method {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-webhook-post-only"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "github-image-webhook-json-only"
    priority = 20

    action {
      block {}
    }

    statement {
      and_statement {
        statement {
          byte_match_statement {
            search_string         = local.github_image_webhook_path
            positional_constraint = "EXACTLY"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }

        statement {
          byte_match_statement {
            search_string         = "POST"
            positional_constraint = "EXACTLY"

            field_to_match {
              method {}
            }

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }

        statement {
          not_statement {
            statement {
              byte_match_statement {
                search_string         = "application/json"
                positional_constraint = "CONTAINS"

                field_to_match {
                  single_header {
                    name = "content-type"
                  }
                }

                text_transformation {
                  priority = 0
                  type     = "LOWERCASE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-webhook-json-only"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "github-image-webhook-rate-limit"
    priority = 30

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 300

        scope_down_statement {
          byte_match_statement {
            search_string         = local.github_image_webhook_path
            positional_constraint = "EXACTLY"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-webhook-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-control-plane"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "control_plane" {
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.control_plane.arn
}
