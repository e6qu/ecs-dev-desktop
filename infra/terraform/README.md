<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# infra/terraform

All AWS infrastructure for ecs-dev-desktop, packaged as a reusable, parametric
Terraform module (Terraform or Terragrunt; one instantiation per environment).

```
modules/ecs-dev-desktop/   the platform module (VPC, DynamoDB, ECR, KMS, IAM,
                           ECS + control-plane service, ALB, ACM/Route53,
                           reconciler schedule, CloudWatch logs) + full README
  tests/sim/               sim-backed `terraform apply` test (sockerless)
examples/complete/         runnable Terraform usage example
examples/terragrunt/       Terragrunt usage example (remote state + provider gen)
versions.tf                provider baseline
```

Start with [`modules/ecs-dev-desktop/README.md`](modules/ecs-dev-desktop/README.md)
for inputs, outputs, architecture, prerequisites, and the deploy flow.

CI (`.github/workflows/ci.yml`): the `terraform` job runs
`terraform fmt -check -recursive`, plus `init -backend=false` + `validate` of the
module and the complete example. The `terraform-sim` job brings up the
from-source sockerless AWS simulator, applies the full module, runs resource and
functional assertions, verifies idempotency, and destroys the stack in the
default, fck-nat, and DNS/TLS configurations. `check-deps` keeps the provider
lock on the latest allowed release.
