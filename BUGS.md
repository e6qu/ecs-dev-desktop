# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

_None._

## Resolved (sockerless — all fixed upstream)

**#508** azure-sim v2.0 OIDC discovery missing `userinfo_endpoint` — `userinfo_endpoint` was
never in the discovery doc; #504's issuer fix let Pomerium get past provider init, surfacing
the gap. Fix: advertise `<baseURL>/{tenant}/v2.0/userinfo` in discovery; implement
`GET /{tenant}/v2.0/userinfo` per OIDC Core §5.3 (RS256 bearer-token verification against
sim's signing key; 401 with `WWW-Authenticate` on missing/invalid token — no fallback identity).
Fixed in PR #510 / submodule `7c812094`.

**BUG-1564** `DescribeTargetGroups` hardcoded `Matcher.HttpCode = "200"` regardless of config —
any non-default matcher (e.g. `200-299`) drifted every `terraform plan`. `ProtocolVersion` and
`IpAddressType` also not parsed/round-tripped. `ModifyTargetGroup` didn't persist
`HealthCheckEnabled` or the matcher. `SetIpAddressType` op unregistered. `EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic` and `CustomerOwnedIpv4Pool` dropped on LBs.
Fixed: full round-trip for all fields; per-protocol defaults (HTTP→`HTTP1`/`200`, NLB→`200-399`);
`SetIpAddressType` registered. Fixed in PR #511 / submodule `9f89ae36`.

**BUG-1561** `CreateVolume`/`DescribeVolumes` never parsed/rendered `Iops`, `Throughput`,
`KmsKeyId`, `MultiAttachEnabled` — gp3 volumes read back null iops/throughput → `aws_ebs_volume`
drifted every plan; `Snapshot` omitted `Encrypted`/`KmsKeyId`. Fixed: `ec2ResolveVolumePerformance`
applies AWS per-type defaults (gp3: 3000 IOPS/125 MBps; gp2: derived from size; io1/io2: from
request); snapshots inherit encryption/kms from source. Fixed in PR #507 / submodule `a00c7e07`.
**BUG-1562** `DescribeVolumes`/`DescribeSnapshots` honoured only explicit id lists; all Filter keys
(`volume-type`/`status`/`tag:`/`volume-id`/`encrypted`/`owner-id`) were ignored → over-match.
`DescribeVolumesModifications` unregistered → `UnknownOperation` on EBS resize/type-change. Fixed:
full filter matchers + OwnerIds; `ModifyVolume` records an `EC2VolumeModification`; new
`DescribeVolumesModifications` handler returns it. Fixed in PR #507 / submodule `a00c7e07`.
**BUG-1560** Key pairs not persisted (`DescribeKeyPairs` always empty); `ModifyInstanceMetadataOptions`
unimplemented; Launch template `CreditSpecification` + `InstanceMarketOptions` (spot) not round-tripped;
`DescribeImages` ignored all filters. Fixed: real `ec2KeyPairs` store with fingerprint + filter support;
`ModifyInstanceMetadataOptions` updates in place; LT credit/spot persisted; `DescribeImages` returns a
deterministic synthesized image matching filter attributes. Fixed in PR #509 / submodule `a00c7e07`
(PR #509 is an ancestor of the HEAD commit `a00c7e07`).

**#504** azure-sim v2.0 OIDC issuer mismatch — `/.well-known/openid-configuration` returned
`sts.windows.net` for all paths including `/v2.0/`; now version-aware: v2.0 → `<baseURL>/<tenant>/v2.0`,
v1 keeps `sts.windows.net`. JWT `iss` aligned for v2.0 id_tokens. Fixed in PR #506 / submodule `0a383db`.
**#501** bleephub admin token now required via `BLEEPHUB_ADMIN_TOKEN` env var — no default, `log.Fatal`
on startup if unset; non-PAT value eliminates Trivy false positive. Fixed in PR #506 / submodule `0a383db`.

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
**#470** EC2 `RunInstances` doesn't stamp `aws:ec2launchtemplate:*` system tags (TF provider
reads these to reconstruct `launch_template` block; absence → ForceNew replacement every plan)
· **#471** `DescribeRouteTables` routes missing `NetworkInterfaceId` · **#472**
`DescribeSecurityGroups` egress rules missing `Ipv6Ranges` · **#473** ELBv2
`DescribeListeners` missing `SslPolicy` for HTTPS listeners · **#469** Azure ACR `/oauth2/`
token service unimplemented → PR #475 (merged 2026-06-06). Submodule → `3d457dd`. All
idempotency checks un-gated; zero open upstream blockers.
**#477** CI query used `AwsvpcConfiguration` (capital A) but the wire key is `awsvpcConfiguration` (lowercase) — JMESPath is case-sensitive; same result on real AWS. Not a sim bug; closed. Fix: lowercased the three JMESPath queries; all three assertions active.
**#483** CloudWatch Logs `FilterLogEvents` returned empty results (`{ events: [] }`) instead of `ResourceNotFoundException` when the log group did not exist — every other CW handler checked group existence but `handleCWFilterLogEvents` skipped it. Real AWS returns HTTP 400 `ResourceNotFoundException`. Integration test was gated. Fixed in PR #484 (merged 2026-06-07); submodule → `4916e15`.
**#486** EventBridge Scheduler stored schedule configuration but never invoked its target. New `scheduler_firing.go`: 1s loop parses `at(...)` / `rate(N minute|hour|day)` and fires ECS RunTask, Lambda Invoke, SQS SendMessage, or SNS Publish in-process. (`cron(...)` not yet evaluated — tracked separately.) Fixed in PR #485 (merged 2026-06-07); submodule → `980dc9e`.
**#488** ECS `RunTask` did not resolve the container definition's `secrets` array — SecretsManager ARNs were stored as opaque passthrough, never fetched and injected as env vars into the container. New `resolveECSContainerSecrets` resolves SecretsManager whole-string or `:jsonKey` refs and SSM by name/ARN at RunTask launch. Fixed in PR #485 (merged 2026-06-07); submodule → `980dc9e`.
**BUG-1531** AWS EventBridge Scheduler `cron(...)` expressions never evaluated — `schedulerFirstFire` returned `false` for all cron expressions; `at()` and `rate()` worked. Added `scheduler_cron.go` with full 6-field AWS cron evaluation (min/hr/dom/mon/dow/year; `*`, `?`, lists, ranges, steps, named months/days). Fixed in PR #491 (merged 2026-06-07); submodule → `dd4e717`.
**#489** EventBridge Scheduler `cron(N/step ...)` mis-parsed — `N/step` collapsed to `lo=hi=N`, so `cron(0/5 * * * ? *)` fired only at minute 0 instead of every 5 minutes. Fixed `cronField` to interpret `N/step` as "N to field-max every step". Fixed in PR #492 (merged 2026-06-07); submodule → `0b9af6e`.
**#490** bleephub `/.well-known/openid-configuration` missing OAuth2 fields — `authorization_endpoint`, `token_endpoint`, `userinfo_endpoint` absent; blocked OIDC-discovery-driven clients and the full Teleport GitHub OAuth headless sim test. Added all three endpoints plus `response_modes_supported`, `grant_types_supported`, and `code` in `response_types_supported`. Fixed in PR #492 (merged 2026-06-07); submodule → `0b9af6e`. Enabled: full Teleport GitHub OAuth login test in `ssh-connect.e2e.ts`.
**#493** EventBridge Scheduler `cron(L/W/# ...)` qualifiers silently never fired — `L` (last day/Saturday), `nL` (last weekday n), `W`/`LW` (nearest weekday), `d#n` (nth weekday) are valid AWS expressions. PR #491 excluded them; a schedule was created successfully but never executed with no error. Also added `ValidationException` for malformed expressions. Fixed in PR #495 (merged 2026-06-07); submodule → `def45a1`.
**#494** bleephub `POST /login/oauth/access_token` always returned JSON — real GitHub returns `application/x-www-form-urlencoded` by default, JSON only with `Accept: application/json`. Now correctly content-negotiated. Existing bleephub tests updated to set `Accept` headers; form-encoded default pinned by new test. Fixed in PR #495 (merged 2026-06-07); submodule → `def45a1`.
**#496** CloudTrail `LookupEvents` ignored 5 of 8 `LookupAttributes` filter keys —
`cloudTrailEventMatches` had no cases for `EventId`, `ResourceType`, `ResourceName`,
`AccessKeyId`, `ReadOnly`; those fell through and returned all events unfiltered. Also: invalid
key now raises `InvalidLookupAttributesException`; `ReadOnly` populated from operation verb;
`AccessKeyId` from SigV4 credential; per-operation `resources[]` extracted in
`cloudtrail_resources.go`. Fixed in PR #500 (merged 2026-06-07); submodule → `fc03b15`.
**#497** Scheduler-fired `RunTask`/`SendMessage`/`Publish`/`Invoke` not recorded in CloudTrail —
`callJSONHandler` called target handlers via `httptest.NewRequest`, bypassing the `POST /`
middleware that calls `cloudTrailRecordAPICall`. Each `fire*Target` now records the downstream
call with `userIdentity.invokedBy = scheduler.amazonaws.com`. Fixed in PR #500 (merged
2026-06-07); submodule → `fc03b15`.
**#498** EventBridge Scheduler API calls (`CreateSchedule` etc.) not recorded in CloudTrail —
`registerScheduler(srv)` used path-based routes outside the `POST /` recording middleware. Each
route now wrapped with `schedulerRecorded`, recording against `scheduler.amazonaws.com`. Fixed in
PR #500 (merged 2026-06-07); submodule → `fc03b15`.

---

Template — `### BUG-NNN — <title>` · Severity · Status · Component · Repro/fix.
