<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# infra/terraform

All AWS infrastructure (VPC, ECS cluster, ECR, DynamoDB single-table + GSIs,
KMS, NLB/ALB, IAM, Teleport). Currently a baseline `versions.tf` only —
resources are added once the target AWS account/region is decided
(`DO_NEXT.md` #5).

CI (`.github/workflows/ci.yml`):
- `terraform fmt -check`, `terraform init -backend=false`, `terraform validate`.
- `check-deps` keeps the provider lock on the latest release.
