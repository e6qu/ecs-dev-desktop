# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

- **[#411](https://github.com/e6qu/sockerless/issues/411) — Terraform/AWS provider: three
  operations unimplemented (open).** Blocks the **full** sim apply-test of the
  `infra/terraform` platform module: KMS `EnableKeyRotation`, Application Auto Scaling
  `RegisterScalableTarget`, and EventBridge Scheduler `CreateSchedule` return
  `UnknownOperationException`/404. Everything else applies against the sim. Per §6.8 the
  module is **not** branched around these; the `terraform-sim` CI job lands once #411 is
  fixed.

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
always-admin) → #401 · **#400** `/admin/organizations` site-admin auth → #401. (Plus
#334/#335 LB/SG enforcement, not we-filed → #364.)

Key outcome: container-mode ECS uses **Docker named volumes**, so the e2e runs with plain
Docker (no KVM/nft). Lesson: a sim that _accepts_ a call can still be non-conformant —
audit behaviour against the real API, not just the happy path (#399).

---

Template — `### BUG-NNN — <title>` · Severity · Status · Component · Repro/fix.
