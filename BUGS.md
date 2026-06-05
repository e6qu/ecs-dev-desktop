# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

_None — all seven gaps filed 2026-06-05 were resolved upstream in PRs #448 + #449 (merged 2026-06-05/06). Submodule → `b174425`._

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
family + `PutClusterCapacityProviders` unimplemented → #418 · **#433** EC2 Launch Template ops (`CreateLaunchTemplate`/`DescribeLaunchTemplates`/
`DescribeLaunchTemplateVersions`/`DeleteLaunchTemplate`) — blocks fck-nat `nat_mode=instance`
(`RaJiska/fck-nat` uses `aws_launch_template` for the ASG launch config) → PR #439
(`ec2_launch_template.go`; `registerEC2LaunchTemplates` wired into `registerEC2`).
**#434** KMS grants (`CreateGrant`/`ListGrants`/`RevokeGrant`) + secondary crypto
(`GenerateDataKeyWithoutPlaintext`/`ReEncrypt`) · **#435** ECR repository policy
(`SetRepositoryPolicy`/`GetRepositoryPolicy`) + image layer data plane
(`InitiateLayerUpload`/`CompleteLayerUpload`/`GetDownloadUrlForLayer`) · **#436** ECS
`DescribeCapacityProviders` + `ListTaskDefinitionFamilies` · **#437** EC2
`DescribeInstanceTypeOfferings` · **#438** ELBv2 `CreateRule`/`DescribeRules`/`ModifyRule`/
`DeleteRule`/`ModifyListener` — all five → PR #440. (All found by live probing 2026-06-05.)
**#441** IAM `ListPolicyVersions` (`InvalidAction`) → blocked `terraform destroy` of `aws_iam_policy`
(fck-nat NAT role policy) · **#442** EC2 `DescribeVpcs` vpc-id/tag filters broken +
`CidrBlockAssociationSet` null (broke `data "aws_vpc"` / fck-nat SG CIDR ingress) · **#443** EC2
`DescribeSecurityGroups` ignored all filters · **#445** CW Logs `CreateLogGroup --kms-key-id`
silently dropped · **#446** ECS `DescribeClusters --include SETTINGS/CONFIGURATIONS` returned null ·
**#447** IAM `ListRoles` (`InvalidAction`) — all six → PR #449 (merged 2026-06-05).
**#444** ECR `imageScanningConfiguration` + `encryptionConfiguration` not persisted → PR #448
(merged 2026-06-05). Submodule → `b174425`.

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
