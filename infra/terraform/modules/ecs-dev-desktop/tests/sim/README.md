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

# DNS/TLS path (ACM cert + Route53 validation + HTTPS listener). Creates a hosted
# zone and sets the module's domain_name, then provisions the ACM/Route53/HTTPS path.
terraform apply -auto-approve -var enable_dns=true
```

## CI

The `terraform-sim` job (`.github/workflows/ci.yml`) brings the sim up and runs
the **full non-mocked apply + verification + idempotency + destroy** of this
fixture against the **live** sim every PR, in three configurations:

- **default** (DNS off) — the entire platform stack, resource assertions, IAM
  simulation, CloudTrail provisioning-event checks, DynamoDB/CloudWatch/ECS
  functional probes, plus a second consumer that reuses an externally-owned VPC
  and ECS cluster without creating network, NAT, endpoint, or cluster resources;
  both configurations are checked for idempotency and destroyed. The default
  and DNS/TLS configurations also change the immutable image tag, inspect the
  saved Terraform plan, apply it, and prove the control-plane service,
  reconciler Scheduler target, and optional SSH-gateway service attach to the
  replacement task definitions.
- **`nat_mode=instance`** — the fck-nat path, including Launch Template, ENI,
  IAM role, idempotency, and destroy.
- **`enable_dns=true`** — the module's ACM cert + Route53 validation + HTTPS
  listener (`dns.tf`), idempotency, and destroy.

## History

Getting here took repeated upstream rounds — each fix let the apply or
idempotency check reach the next real gap, all filed per §6.8 and fixed upstream:

| Round | Gap                                                                              | Fixed by                                            |
| ----- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1     | KMS `EnableKeyRotation`, Application Auto Scaling, EventBridge Scheduler (#411)  | [#410](https://github.com/e6qu/sockerless/pull/410) |
| 2     | KMS tagging hang (#413), NAT Gateway hang (#414)                                 | [#415](https://github.com/e6qu/sockerless/pull/415) |
| 3     | DynamoDB dropped GSIs (#416), ECS Service family unimplemented (#417)            | [#418](https://github.com/e6qu/sockerless/pull/418) |
| 4     | ACM cert never reached ISSUED (#420), ACM wildcard validation record name (#421) | [#424](https://github.com/e6qu/sockerless/pull/424) |
