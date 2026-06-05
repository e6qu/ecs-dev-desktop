# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

The module's **default** full apply+destroy (DNS off) is green and runs every PR
(`terraform-sim` CI job): `Apply complete! 55 added` → `Destroy complete! 55 destroyed`. The
three rounds of gaps that blocked it are all fixed upstream (#411→#410, #413/#414→#415,
#416/#417→#418; see Resolved below).

Two new gaps block only the module's **DNS/TLS path** (`dns.tf`: ACM cert + Route53
validation + HTTPS listener), exercised by `tests/sim` with `-var enable_dns=true` (the
gated `terraform-sim` DNS step). Per §6.8 the module is **not** branched around them; flip
`RUN_SIM_DNS=1` once both land. The module hits #421 first (wildcard cert), then #420.

- **[#421](https://github.com/e6qu/sockerless/issues/421) — ACM wildcard-SAN validation
  record name carries a literal `*` (open).** For `*.devbox.<domain>` the sim emits the DVO
  `ResourceRecord.Name` as `_acm-challenge.*.devbox…` (real ACM strips the `*.` and validates
  the base). The star-bearing `aws_route53_record` makes `aws_acm_certificate_validation`
  fail `missing … DNS validation record`. Fix: de-wildcard the validation record name.
- **[#420](https://github.com/e6qu/sockerless/issues/420) — ACM cert never reaches `ISSUED`
  (open).** A DNS-validated cert stays `PENDING_VALIDATION` forever (no status transition;
  no ACM↔Route53 reconciliation), so `aws_acm_certificate_validation` hangs until its 45-min
  timeout. The sim's own `acm.go` comment claims it eagerly issues — but only
  `ImportCertificate` does; `RequestCertificate` doesn't.

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
