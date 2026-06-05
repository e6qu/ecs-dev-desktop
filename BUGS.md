# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

_None._ The `infra/terraform` platform module's **full non-mocked apply+destroy** against the
sim is green and runs every PR (`terraform-sim` CI job): `Apply complete! 55 added` →
`Destroy complete! 55 destroyed`. The three rounds of gaps that blocked it are all fixed
upstream (#411→#410, #413/#414→#415, #416/#417→#418; see Resolved below).

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
**#414** `CreateNatGateway` had no API-only modeled path → #415 · **#416** DynamoDB
`DescribeTable`/`CreateTable` dropped GlobalSecondaryIndexes → #418 · **#417** ECS Service
family + `PutClusterCapacityProviders` unimplemented → #418. (Plus #334/#335 LB/SG
enforcement, not we-filed → #364.)

Key outcome: container-mode ECS uses **Docker named volumes**, so the e2e runs with plain
Docker (no KVM/nft). Lesson: a sim that _accepts_ a call can still be non-conformant —
audit behaviour against the real API, not just the happy path (#399).

---

Template — `### BUG-NNN — <title>` · Severity · Status · Component · Repro/fix.
