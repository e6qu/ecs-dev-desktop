# SPDX-License-Identifier: AGPL-3.0-or-later
# Provider requirements for the ecs-dev-desktop platform module. The AWS provider
# is configured by the *caller* (root module / Terragrunt); this module does not
# declare a `provider` block, so it composes cleanly under any account/region.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
