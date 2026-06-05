# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

### #433 — EC2 Launch Template ops unimplemented — blocks fck-nat `nat_mode=instance`

**Status:** Open (filed 2026-06-05) · **Upstream:** e6qu/sockerless#433

`CreateLaunchTemplate`, `DescribeLaunchTemplates`, `DescribeLaunchTemplateVersions`,
`DeleteLaunchTemplate` all return `InvalidAction`. The `RaJiska/fck-nat` module uses
`aws_launch_template` for the NAT instance ASG launch config — `terraform apply -var
nat_mode=instance` fails at the launch-template resource. The `terraform-sim` fck-nat
step is gated on this fix. Source: `simulators/aws/ec2.go:registerEC2` — no launch
template handlers registered.

Standalone ENI ops (#428) were already fixed upstream by #430. This is the next layer.

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
family + `PutClusterCapacityProviders` unimplemented → #418 · **#434** KMS grants (`CreateGrant`/`ListGrants`/`RevokeGrant`) + secondary crypto
(`GenerateDataKeyWithoutPlaintext`/`ReEncrypt`) · **#435** ECR repository policy
(`SetRepositoryPolicy`/`GetRepositoryPolicy`) + image layer data plane
(`InitiateLayerUpload`/`CompleteLayerUpload`/`GetDownloadUrlForLayer`) · **#436** ECS
`DescribeCapacityProviders` + `ListTaskDefinitionFamilies` · **#437** EC2
`DescribeInstanceTypeOfferings` · **#438** ELBv2 `CreateRule`/`DescribeRules`/`ModifyRule`/
`DeleteRule`/`ModifyListener` — all five → PR #440. (All found by live probing 2026-06-05.)

**#420** ACM DNS-validated
cert never reached `ISSUED` + **#421** ACM wildcard-SAN validation record name carried a
literal `*` → #424 · **#427** IAM policy simulation unimplemented (`SimulateCustomPolicy`/
`SimulatePrincipalPolicy` returned `InvalidAction`; no evaluation engine) → #431 (added full
evaluator: explicit-deny-wins, wildcard actions/resources, `StringEquals`/`ArnLike`/`Bool`/
`IfExists` conditions, `NotAction`/`NotResource`, `MissingContextValues`) · **#428** EC2
standalone ENI ops unimplemented (`CreateNetworkInterface`, Attach/Detach/Modify/Delete) →
#430 (blocks `nat_mode=instance` fck-nat path in Terraform) · **BUG-1470** EC2
position-dependent filters ignored (`DescribeNatGateways`/`DescribeSubnets`/
`DescribeRouteTables` silently dropped any filter not at position 1) → #429. (Plus
#334/#335 LB/SG enforcement, not we-filed → #364.)

Key outcome: container-mode ECS uses **Docker named volumes**, so the e2e runs with plain
Docker (no KVM/nft). Lesson: a sim that _accepts_ a call can still be non-conformant —
audit behaviour against the real API, not just the happy path (#399).

---

Template — `### BUG-NNN — <title>` · Severity · Status · Component · Repro/fix.
