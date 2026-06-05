# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

### #441 — IAM ListPolicyVersions unimplemented — blocks fck-nat aws_iam_policy destroy

**Status:** Open (filed 2026-06-05) · **Upstream:** e6qu/sockerless#441

`ListPolicyVersions` returns `InvalidAction`. The Terraform AWS provider calls it during plan/refresh/destroy to read back `aws_iam_policy` resources. The `RaJiska/fck-nat` module creates an `aws_iam_policy` for the NAT instance — `terraform destroy -var nat_mode=instance` fails with `UnknownError` and leaves the policy in state. CI workaround (fck-nat step only): `terraform state rm` the stuck resource + `aws iam delete-policy` before re-running destroy. All other IAM ops (`CreatePolicy`/`GetPolicy`/`GetPolicyVersion`/`DeletePolicy`) work correctly.

### #442 — EC2 DescribeVpcs filtering completely broken (vpc-id, tag filters; CidrBlockAssociationSet always null)

**Status:** Open (filed 2026-06-05) · **Upstream:** e6qu/sockerless#442

Three distinct non-conformances: (1) `--vpc-ids` returns `vpc-sim` regardless of requested IDs; (2) `--filters "Name=vpc-id,Values=X"` returns wrong VPCs (not the requested one); (3) `CidrBlockAssociationSet` is always null. Affects `data "aws_vpc"` (used by fck-nat to get VPC CIDR for SG rules) and any VPC-by-ID or VPC-by-tag lookup. CI assertions use `vpc_id` from Terraform output directly; subnet/NAT/route-table `vpc-id` filters work correctly for those resource types.

### #443 — EC2 DescribeSecurityGroups all filters return all SGs (vpc-id, group-name, group-id ignored)

**Status:** Open (filed 2026-06-05) · **Upstream:** e6qu/sockerless#443

`DescribeSecurityGroups` with any filter (`vpc-id`, `group-name`) returns ALL security groups in the sim, ignoring the filter entirely. CI assertions use `--group-ids <id>` (direct lookup by ID from Terraform outputs) as a workaround; `describe-security-group-rules` with `group-id` filter continues to work correctly.

### #444 — ECR imageScanningConfiguration and encryptionConfiguration not persisted

**Status:** Open (filed 2026-06-05) · **Upstream:** e6qu/sockerless#444

`CreateRepository` accepts `--image-scanning-configuration` and `--encryption-configuration` without error, but `DescribeRepositories` returns null for both fields. The Terraform module sets `scan_on_push = true` and `encryption_type = KMS` on all ECR repos — these cannot be verified post-apply until fixed. CI assertions are gated.

### #445 — CloudWatch Logs CreateLogGroup kmsKeyId not persisted

**Status:** Open (filed 2026-06-05) · **Upstream:** e6qu/sockerless#445

`CreateLogGroup --kms-key-id` succeeds but drops the key ID. `DescribeLogGroups` always returns null for `kmsKeyId`. The platform module sets KMS encryption on all 3 log groups — cannot be verified post-apply until fixed. CI assertions are gated.

### #446 — ECS DescribeClusters --include SETTINGS/CONFIGURATIONS returns null for both

**Status:** Open (filed 2026-06-05) · **Upstream:** e6qu/sockerless#446

`DescribeClusters --include SETTINGS CONFIGURATIONS` returns null for `settings` (containerInsights) and `configuration` (executeCommandConfiguration KMS key). The cluster is created with `containerInsights=enabled` and KMS exec — neither is verifiable post-apply until fixed. CI assertions are gated.

### #447 — IAM ListRoles unimplemented (InvalidAction)

**Status:** Open (filed 2026-06-05) · **Upstream:** e6qu/sockerless#447

`ListRoles` returns `InvalidAction`. Doesn't block Terraform (which uses `GetRole` by name), but blocks bulk enumeration assertions (e.g. verifying all 5 expected platform roles exist via a list). CI assertions use `GetRole` by name individually as a workaround.

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
