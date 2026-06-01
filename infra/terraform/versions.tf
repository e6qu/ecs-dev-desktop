# SPDX-License-Identifier: AGPL-3.0-or-later
# Baseline provider requirements. Resources land in Phase 0/2 once the target
# AWS account/region is set (see DO_NEXT.md, decision #5). The committed
# .terraform.lock.hcl + the `check-deps` CI job keep providers on latest.

terraform {
  required_version = ">= 1.13"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}
