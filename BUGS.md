# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

### #470 — EC2: DescribeInstances doesn't return LaunchTemplateSpecification

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#470

When `RunInstances` is called with a `LaunchTemplate` specification, subsequent `DescribeInstances` calls return the instance without `LaunchTemplate` in the response. The Terraform `aws_instance` provider stores `launch_template { id, version }` in state; on refresh it sees the attribute missing and triggers a ForceNew replacement every idempotency plan. Affects fck-nat NAT instance path only.

### #471 — EC2: DescribeRouteTables route entries missing NetworkInterfaceId

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#471

When `CreateRoute` is called with `NetworkInterfaceId`, subsequent `DescribeRouteTables` calls return the route entry without `NetworkInterfaceId`. TF's `aws_route` provider sees the attribute missing and plans an in-place update on every idempotency plan. Affects fck-nat routes that target the NAT instance's static ENI.

### #472 — EC2: DescribeSecurityGroups egress rules missing Ipv6Ranges

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#472

When `AuthorizeSecurityGroupEgress` is called with both `IpRanges` and `Ipv6Ranges`, subsequent `DescribeSecurityGroups` returns the rule with `IpRanges` populated but `Ipv6Ranges` empty. TF's `aws_security_group` provider sees `ipv6_cidr_blocks` missing from the egress rule and plans an in-place update every idempotency plan. Affects fck-nat SG that allows all-egress to both IPv4 and IPv6.

Fck-nat idempotency check re-gated on #470/#471/#472. Default idempotency remains un-gated and fail-fast.

### #473 — ELBv2: DescribeListeners doesn't return SslPolicy for HTTPS listeners

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#473

When `CreateListener` is called with `SslPolicy = "ELBSecurityPolicy-TLS13-1-2-2021-06"` for an HTTPS listener, subsequent `DescribeListeners` calls return the listener without the `SslPolicy` field. TF's `aws_lb_listener` provider sees the attribute missing and plans an in-place update on every idempotency plan (`0 to add, 1 to change, 0 to destroy` on `aws_lb_listener.https`). DNS/TLS idempotency re-gated on #473. Default idempotency unaffected.

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
**#453** DynamoDB `SSEDescription` null · **#454** ECS `deploymentConfiguration` null ·
**#455** EC2 `ModifySecurityGroupRules` unimplemented → PR #463 (merged 2026-06-06).
**#450–#452** OCI `/v2/` data plane (ECR/AR/ACR) → PR #456 (merged 2026-06-06).
**#457** SG egress `from_port`/`to_port`=0 for ip_protocol=-1 · **#458** SG ingress
`referenced_security_group_id` account-prefix · **#459** NAT Gateway `connectivity_type`
not persisted · **#460** ECS task-def drops `healthCheck`/`secrets` · **#461** ALB
`minimum_load_balancer_capacity` spurious capacity_units=0 · **#462** Tags not returned by
`ListTagsForResource` family (CW/DynamoDB/ECR/ECS) · **#464** ELBv2 `DescribeListeners`
`Certificates` absent for HTTPS listeners → PR #466 (merged 2026-06-06). Submodule →
`1859adf`. All CI assertions and idempotency checks un-gated; zero open upstream blockers.
**#467** ECS task-def tags not returned (`DescribeTaskDefinition --include TAGS` path — tags
leaked inside `taskDefinition` object, silently dropped by SDK model) · **#465** OCI `/v2/`
responses missing `Docker-Distribution-Api-Version` header on non-ping routes → PR #468
(merged 2026-06-06). Submodule → `3db617e`.

---

Template — `### BUG-NNN — <title>` · Severity · Status · Component · Repro/fix.
