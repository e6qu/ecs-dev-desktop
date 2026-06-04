# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

Both block the **full** sim apply-test of the `infra/terraform` platform module. Per §6.8
the module is **not** branched around them; the full-apply step of the `terraform-sim` CI
job is gated off and lands once both are fixed (the job's `init`/`validate`/`plan` against
the live sim runs every PR today).

These are the **second** layer of gaps: the full apply now reaches DynamoDB GSI creation
and the ECS service (the prior KMS-tag/NAT hangs were fixed by #415, below).

- **[#416](https://github.com/e6qu/sockerless/issues/416) — DynamoDB drops GSIs (open).**
  `DescribeTable`/`CreateTable` return `GlobalSecondaryIndexes: null` (the `DDBTable` struct
  has no GSI field; the `CreateTable` request never parses them). The AWS provider waits for
  each GSI's `IndexStatus` to reach `ACTIVE`, never finds it, and fails after ~21 retries.
  Blocks any `aws_dynamodb_table` with a GSI — i.e. every single-table design (`@edd/db`
  uses GSI1 + GSI2). DynamoDB Local accepts the same schema, so this is sim-specific.
- **[#417](https://github.com/e6qu/sockerless/issues/417) — ECS Service family
  unimplemented (open).** `CreateService`/`DescribeServices`/`ListServices`/`UpdateService`/
  `DeleteService` and `PutClusterCapacityProviders` return `UnknownOperationException`
  (clusters + task definitions + `RunTask` work). Blocks `aws_ecs_service` and
  `aws_ecs_cluster_capacity_providers` — i.e. any Fargate **service** (our control plane).

Policy (`AGENTS.md` §6.8 + standing directive): the **whole project** (product code _and_
tests) differs from the real-cloud path by **endpoint/base-domain only** — no sim-specific
endpoints, branches, fixtures, tokens, fallbacks. If the sim/bleephub **diverges from the
real API/behaviour** in something that matters, **file a non-conformance upstream and
halt** — never adapt around it. Precise filings (repro + code pointer) get fixed in hours.

## Resolved (sockerless — all fixed upstream)

We filed and got fixed, in order: **#359/#360** (EBS snapshots / DeleteItem) → PR #361 ·
**#362** Entra authorize → #368 · **#366/#367** sim Dockerfile + `SIM_RUNTIME=process` →
#370 · **#333** real Firecracker microVMs → #372 · **#378** EC2 AttachVolume → #379 ·
**#381** control/data-plane coupling (Docker named volumes) → #382 · **#384** bleephub
`/user/teams` → #385 · **#387** Entra `groups` claim → #389 · **#390** Entra provisioning
must be standard Graph + ROPC (not a sim-only seed) → #393 · **#391** bleephub standard
`POST /admin/organizations` → #393 · **#399** bleephub OAuth non-conformance (session/CSRF;
always-admin) → #401 · **#400** `/admin/organizations` site-admin auth → #401 · **#411**
Terraform/AWS provider: KMS `EnableKeyRotation` + Application Auto Scaling
`RegisterScalableTarget` + EventBridge Scheduler `CreateSchedule` unimplemented → #410 ·
**#413** KMS tagging (`TagResource`/`UntagResource` + `ListResourceTags` empty) → #415 ·
**#414** `CreateNatGateway` had no API-only modeled path → #415. (Plus #334/#335 LB/SG
enforcement, not we-filed → #364.)

Key outcome: container-mode ECS uses **Docker named volumes**, so the e2e runs with plain
Docker (no KVM/nft). Lesson: a sim that _accepts_ a call can still be non-conformant —
audit behaviour against the real API, not just the happy path (#399).

---

Template — `### BUG-NNN — <title>` · Severity · Status · Component · Repro/fix.
