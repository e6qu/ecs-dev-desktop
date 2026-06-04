<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Sim-backed apply test

Applies the platform module against the **sockerless** AWS simulator. Per
AGENTS.md §6.8 the only difference from a real-cloud apply is the provider
`endpoints` (pointed at `var.sim_endpoint`) + dummy credentials — there are **no**
module branches for the sim.

## Run

```sh
# Bring the sim up (from the repo root):
docker compose -f docker-compose.tier2.yml up -d --build sockerless-aws

cd infra/terraform/modules/ecs-dev-desktop/tests/sim
terraform init
terraform apply -auto-approve     # provisions the full stack against the sim
terraform destroy -auto-approve
```

## CI

The `terraform-sim` job (`.github/workflows/ci.yml`) brings the sim up and runs
`init` + `validate` + `plan` of this fixture against the **live** sim every PR —
a real, non-mocked exercise of the provider/endpoint wiring and the module's
plan graph (the plan reaches the sim: STS `GetCallerIdentity` etc.).

The full `apply` + `destroy` step is wired in the same job but **gated off**,
pending two sim gaps below. Flip `RUN_SIM_APPLY=1` once both land.

## Status: full apply blocked on two sim gaps

Earlier rounds are now fixed upstream and the full apply gets **further every
time**: [#411](https://github.com/e6qu/sockerless/issues/411) (KMS
`EnableKeyRotation`, Application Auto Scaling, EventBridge Scheduler) →
[#410](https://github.com/e6qu/sockerless/pull/410); then
[#413](https://github.com/e6qu/sockerless/issues/413) (KMS tagging hang) and
[#414](https://github.com/e6qu/sockerless/issues/414) (NAT Gateway hang) →
[#415](https://github.com/e6qu/sockerless/pull/415). The apply now reaches
DynamoDB GSI creation and the ECS service, surfacing two further gaps, filed
upstream:

| Issue                                                            | Symptom                                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#416](https://github.com/e6qu/sockerless/issues/416) (DynamoDB) | `DescribeTable`/`CreateTable` return `GlobalSecondaryIndexes: null` → `aws_dynamodb_table` fails the GSI `ACTIVE` wait (~21 retries).             |
| [#417](https://github.com/e6qu/sockerless/issues/417) (ECS)      | Service family (`CreateService`/…) + `PutClusterCapacityProviders` unimplemented → `aws_ecs_service` / `aws_ecs_cluster_capacity_providers` fail. |

Per AGENTS.md §6.8 the module is **not** branched around either gap; the full
apply lands in CI once both are fixed.
