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
the **full non-mocked apply + destroy** of this fixture against the **live** sim
every PR, in **both** configurations:

- **default** (DNS off) — the entire platform stack: `Apply complete! 55 added` →
  `Destroy complete! 55 destroyed`.
- **`enable_dns=true`** — adds the module's ACM cert + Route53 validation + HTTPS
  listener (`dns.tf`): `Apply complete! 64 added` → `Destroy complete! 64 destroyed`.

## History

Getting here took four upstream rounds — each fix let the apply reach the next
real gap, all filed per §6.8 and fixed upstream:

| Round | Gap                                                                              | Fixed by                                            |
| ----- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1     | KMS `EnableKeyRotation`, Application Auto Scaling, EventBridge Scheduler (#411)  | [#410](https://github.com/e6qu/sockerless/pull/410) |
| 2     | KMS tagging hang (#413), NAT Gateway hang (#414)                                 | [#415](https://github.com/e6qu/sockerless/pull/415) |
| 3     | DynamoDB dropped GSIs (#416), ECS Service family unimplemented (#417)            | [#418](https://github.com/e6qu/sockerless/pull/418) |
| 4     | ACM cert never reached ISSUED (#420), ACM wildcard validation record name (#421) | [#424](https://github.com/e6qu/sockerless/pull/424) |
