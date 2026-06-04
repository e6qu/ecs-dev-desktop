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

A prior round of gaps ([#411](https://github.com/e6qu/sockerless/issues/411) — KMS
`EnableKeyRotation`, Application Auto Scaling `RegisterScalableTarget`, EventBridge
Scheduler `CreateSchedule`) was **fixed upstream by
[#410](https://github.com/e6qu/sockerless/pull/410)**; those operations now succeed
against the sim.

The full apply now surfaces two further gaps, filed upstream:

| Issue                                                       | Symptom                                                                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [#413](https://github.com/e6qu/sockerless/issues/413) (KMS) | `TagResource`/`UntagResource` unimplemented; `ListResourceTags` returns empty tags → `aws_kms_key` hangs 10m then times out.  |
| [#414](https://github.com/e6qu/sockerless/issues/414) (EC2) | `CreateNatGateway` hard-requires host `CAP_NET_ADMIN`/`nft` with no modeled fallback → `aws_nat_gateway` hangs until timeout. |

Per AGENTS.md §6.8 the module is **not** branched around either gap; the full
apply lands in CI once both are fixed.
