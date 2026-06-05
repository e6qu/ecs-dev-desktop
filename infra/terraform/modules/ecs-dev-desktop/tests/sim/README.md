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
# zone and sets the module's domain_name. Currently blocked upstream — see below.
terraform apply -auto-approve -var enable_dns=true
```

## CI

The `terraform-sim` job (`.github/workflows/ci.yml`) brings the sim up and runs
the **full non-mocked apply + destroy** of this fixture against the **live** sim
every PR — `init` + `validate`, then `apply` of the entire platform stack and
`destroy`. A green run is `Apply complete! 55 added` → `Destroy complete! 55
destroyed`.

A second, **gated** step (`RUN_SIM_DNS=1`) re-applies with `enable_dns=true` to
exercise the module's ACM/Route53/HTTPS path. It is off until the two ACM gaps
below land; flip `RUN_SIM_DNS` once they do.

## DNS/TLS path: blocked on two ACM sim gaps

The module's `dns.tf` (cert for `app.<domain>` + the `*.devbox.<domain>` wildcard,
DNS-validated, fronting an HTTPS ALB listener) applies against the sim up to the
ACM validation, where it hits two gaps (filed per §6.8). The wildcard cert hits
**#421 first**, then **#420**:

| Issue                                                       | Symptom                                                                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [#421](https://github.com/e6qu/sockerless/issues/421) (ACM) | Wildcard-SAN validation record name carries a literal `*` → `aws_acm_certificate_validation` fails `missing … DNS record`. |
| [#420](https://github.com/e6qu/sockerless/issues/420) (ACM) | Cert never transitions `PENDING_VALIDATION → ISSUED` → the validation wait hangs (45-min timeout).                         |

## History

Getting here took three upstream rounds — each fix let the apply reach the next
real gap, all filed per §6.8 and fixed upstream:

| Round | Gap                                                                             | Fixed by                                            |
| ----- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1     | KMS `EnableKeyRotation`, Application Auto Scaling, EventBridge Scheduler (#411) | [#410](https://github.com/e6qu/sockerless/pull/410) |
| 2     | KMS tagging hang (#413), NAT Gateway hang (#414)                                | [#415](https://github.com/e6qu/sockerless/pull/415) |
| 3     | DynamoDB dropped GSIs (#416), ECS Service family unimplemented (#417)           | [#418](https://github.com/e6qu/sockerless/pull/418) |
