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

## Status: blocked on three sim operations

A full apply currently fails on three operations the sim does not implement,
filed as [`e6qu/sockerless#411`](https://github.com/e6qu/sockerless/issues/411):

| Service                  | Operation                | Sim response                                                                      |
| ------------------------ | ------------------------ | --------------------------------------------------------------------------------- |
| KMS                      | `EnableKeyRotation`      | `UnknownOperationException: TrentService.EnableKeyRotation` (400)                 |
| Application Auto Scaling | `RegisterScalableTarget` | `UnknownOperationException: AnyScaleFrontendService.RegisterScalableTarget` (400) |
| EventBridge Scheduler    | `CreateSchedule`         | `404` (service unrouted)                                                          |

Everything else applies cleanly against the sim (STS, IAM, KMS `CreateKey`, EC2,
DynamoDB, ECR, ELBv2, ACM, Route53, CloudWatch Logs, Secrets Manager, ECS). Once
#411 lands, this test runs in CI as a `terraform-sim` job alongside the other
sim-backed tiers — we do not work around the gaps here.
