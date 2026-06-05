# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

### #457 — EC2 SG egress rule from_port/to_port stored as 0 instead of null for ip_protocol=-1

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#457

`AuthorizeSecurityGroupEgress` with `IpProtocol="-1"` (all-traffic) stores `FromPort=0, ToPort=0`. Real AWS omits these fields for all-traffic rules. `DescribeSecurityGroupRules` returns them, so Terraform sees `from_port = 0 -> null` on every idempotency plan for `aws_vpc_security_group_egress_rule` resources. Affects both ALB and tasks egress rules. Idempotency check gated (#457–#462 combined).

### #458 — EC2 VPC SG ingress rule referenced_security_group_id returned with account-ID prefix

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#458

`DescribeSecurityGroupRules` returns `ReferencedGroupInfo.GroupId` as `"<accountId>/<sg-id>"` instead of bare `"<sg-id>"`. Causes `referenced_security_group_id = "123456789012/sg-…" -> "sg-…"` drift on every idempotency plan for the tasks-from-ALB ingress rule.

### #459 — EC2 NatGateway connectivity_type not persisted, forcing Terraform to replace every plan

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#459

`DescribeNatGateways` omits `ConnectivityType`. The TF provider treats `connectivity_type` as `ForceNew`; the absent value causes a destroy+create plan on every idempotency check, cascading to both `aws_route.private_nat` resources.

### #460 — ECS DescribeTaskDefinition drops healthCheck and secrets from containerDefinitions

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#460

`RegisterTaskDefinition` accepts `healthCheck` and `secrets` in container definitions, but `DescribeTaskDefinition` returns the container definitions without those fields. The TF provider stores these in state on create; seeing them absent forces a new task-def revision (replacement) on every idempotency plan, cascading to ECS service (`task_definition`) and IAM inline policies (which reference the task-def ARN).

### #461 — ELBv2 DescribeLoadBalancerAttributes returns minimum_load_balancer_capacity.capacity_units=0 spuriously

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#461

`DescribeLoadBalancerAttributes` returns `minimum_load_balancer_capacity.capacity_units = "0"` for ALBs created without minimum capacity configuration. Real AWS omits this attribute entirely. Causes `minimum_load_balancer_capacity { capacity_units = 0 -> null }` drift on every idempotency plan.

### #462 — Tags not returned by ListTagsForResource/ListTagsOfResource/ListTagsLogGroup for CloudWatch Logs, DynamoDB, ECR, ECS

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#462

Tags set at resource-creation time are not returned by the per-service tag-list APIs. Affects: `logs:ListTagsForResource` (CW log groups), `dynamodb:ListTagsOfResource` (DynamoDB table), `ecr:ListTagsForResource` (ECR repos), `ecs:ListTagsForResource` (ECS task definitions). All 9 affected resources show tag additions on every idempotency plan. EC2 resources are unaffected (tags embedded in `Describe*` responses).

### #453 — DynamoDB SSEDescription null (server_side_encryption not reflected in DescribeTable)

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#453

`CreateTable` with `--sse-specification Enabled=true,SSEType=KMS,KMSMasterKeyId=<arn>` succeeds, but `DescribeTable` returns `null` for `SSEDescription`. Real AWS returns `{Status: ENABLED, SSEType: KMS, KMSMasterKeyArn: <arn>}`. The Terraform provider currently does not read back `SSEDescription` for drift detection (idempotency passes), but CI assertions verifying encryption-at-rest are gated.

### #454 — ECS DescribeServices deploymentConfiguration null (deploymentCircuitBreaker not stored)

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#454

`CreateService` accepts `--deployment-configuration` (including `deploymentCircuitBreaker={enable=true,rollback=true}`) without error, but `DescribeServices` returns `null` for the entire `deploymentConfiguration` field. Real AWS returns the full object. Idempotency passes (provider doesn't diff `deploymentCircuitBreaker` currently), but CI assertions on the deployment safety control are gated.

### #455 — EC2 ModifySecurityGroupRules unimplemented (InvalidAction)

**Status:** Open (filed 2026-06-06) · **Upstream:** e6qu/sockerless#455

`ModifySecurityGroupRules` returns `InvalidAction`. Called by the Terraform AWS provider v6 when updating an existing `aws_vpc_security_group_ingress_rule` or `aws_vpc_security_group_egress_rule` in-place (i.e., re-applying a config that modifies a rule rather than delete+recreate it). Fresh apply/destroy cycles use `AuthorizeSecurityGroupIngress`/`Egress` (which work); this gap only triggers on in-place updates. Does not block current CI (each configuration is a fresh apply).

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
