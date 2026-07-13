# SPDX-License-Identifier: AGPL-3.0-or-later
# Provider requirements for the ecs-dev-desktop platform module. The regional AWS
# provider is configured by the *caller* (root module / Terragrunt); this module
# does not declare a default `provider` block, so it composes cleanly under any
# account/region.
#
# CloudFront + its viewer ACM cert + the CLOUDFRONT-scope WAFv2 web ACL/IP set are
# GLOBAL resources that AWS only accepts in us-east-1. A child module cannot declare
# its own `provider` block, so it declares an aliased provider REQUIREMENT
# (`configuration_aliases`) that the caller must pass as
# `providers = { aws = ..., aws.us_east_1 = ... }` (see examples/complete/main.tf).

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 6.0"
      configuration_aliases = [aws.us_east_1]
    }
    # Generates the wake-path shared secret (random_password.wake_token). CloudFront injects it as a
    # custom origin header the public wake Function URL verifies — see cloudfront.tf.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
