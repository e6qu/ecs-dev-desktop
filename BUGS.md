# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.

## Open

_(none)_

## External blockers (upstream — `e6qu/sockerless`)

_(none — sockerless#516 resolved by PR #518; follow-up overlapping-CIDR fabric resolved by PR #519, both merged 2026-06-08)_

## Resolved (sockerless — fixed upstream; full detail in `WHAT_WE_DID.md`)

**Most-recent batch** (submodule `cf7df7c`, PR #519):

- **BUG-1572 / PR #519** — Follow-up to sockerless#516: the Docker-bridge VPC fabric from
  PR #518 could not represent two AWS VPCs with overlapping CIDRs, and `DeleteVpc` leaked
  backing networks. Fix: a Linux network-namespace-per-VPC fabric (`VPC = netns`,
  `subnet = bridge`) for capable hosts, with ECS awsvpc tasks sharing a pause-container
  network namespace and keeping the real ENI IP with no CIDR remap. The older Docker-network
  tier remains for distinct CIDRs when netns capabilities are unavailable; overlap fails
  loudly there. Added tier-agnostic VPC reachability/isolation tests, a netns-only
  overlapping-CIDR test, and VPC fabric cleanup coverage.

**Previous batch** (submodule `7518722`, PR #518):

- **sockerless#516** — Container-mode ECS: `privateIPv4Address` was a virtual VPC-allocated IP
  that didn't route to the Docker container. Fix: each VPC is now a real Docker user-defined
  bridge (`sockerless-sim-vpc-<vpcid>`, IPAM subnet = VPC CIDR). Task containers are pinned to
  their VPC bridge at the ENI IP via `ContainerConfig.IPAddress`. The reported IP is now the
  container's real Docker IP — routable within the VPC bridge (intra-VPC), isolated from other
  VPC bridges (cross-VPC). Our `sshHost` field on `Workspace` is now populated with an
  actionable IP; the proxy e2e tests the full forwarding chain.

**Previous batch** (submodule `4b8bcd9`, PR #515):

- **sockerless#514** — Container-mode sim: scheduler-fired `RunTask` (EcsParameters target)
  silently swallowed downstream errors. `callJSONHandler` discarded the response and
  `fireECSTarget` recorded CloudTrail success unconditionally; the task was never launched
  or stopped. Also: SG validation was skipped for scheduler-fired path but enforced for
  direct `RunTask`. Fix: `callJSONHandler` now returns `(status, body)`; a shared
  `recordSchedulerFireResult` records failures honestly with `errorCode`/`errorMessage`;
  valid-config happy path unchanged. **Our e2e test updated to use real VPC/subnet/SG
  (commit `52376c2`)**.

**Most-recent batch** (submodule `9f89ae36`, PRs #507–#511):

- **BUG-1564** ELBv2 TG `Matcher` hardcoded `"200"`, `ProtocolVersion`/`IpAddressType` not round-tripped, `SetIpAddressType` unregistered. → PR #511 / `9f89ae36`.
- **#508** azure-sim v2.0 OIDC discovery missing `userinfo_endpoint`; `GET /{tenant}/v2.0/userinfo` not implemented (OIDC Core §5.3). → PR #510 / `7c812094`.
- **BUG-1561/1562** EBS volume performance fields (`Iops`/`Throughput`/`KmsKeyId`) not round-tripped; `DescribeVolumes`/`DescribeSnapshots` filters ignored; `DescribeVolumesModifications` unregistered. → PR #507 / `a00c7e07`.
- **BUG-1560** `DescribeKeyPairs` always empty; `ModifyInstanceMetadataOptions` unimplemented; LT credit/spot not round-tripped; `DescribeImages` filters ignored. → PR #509 / `a00c7e07` (ancestor).

**Earlier batches** (full detail in `WHAT_WE_DID.md`):

- **#504/#501** azure-sim OIDC v2.0 issuer mismatch; bleephub admin token non-configurable. → PR #506 / `0a383db`.
- **#496–#498** CloudTrail `LookupEvents` filter keys, scheduler API recording, scheduler-fired calls not recorded. → PR #500 / `fc03b15`.
- **#493/#494** Scheduler cron `L/W/#` qualifiers; bleephub token response content-type. → PR #495 / `def45a1`.
- **BUG-1531/#489/#490** Scheduler `cron()` never evaluated; `N/step` mis-parsed; bleephub OIDC discovery endpoints missing. → PRs #491+#492 / `0b9af6e`.
- **#486–#488** Scheduler never fired targets; ECS `RunTask` didn't resolve `secrets`. → PR #485 / `980dc9e`.
- **#483** CloudWatch Logs `FilterLogEvents` returned empty instead of `ResourceNotFoundException`. → PR #484 / `4916e15`.
- **#467/#465** ECS task-def tags not returned by `DescribeTaskDefinition --include TAGS`; OCI `/v2/` missing `Docker-Distribution-Api-Version`. → PR #468 / `3db617e`.
- **#470–#473** `RunInstances` missing `aws:ec2launchtemplate:*` system tags; `DescribeRouteTables` routes missing `NetworkInterfaceId`; SG egress `Ipv6Ranges` absent; `DescribeListeners` missing `SslPolicy`. → PR #475 / `3d457dd`.
- **#453–#462/#464** DynamoDB SSEDescription null; ECS deploymentConfig null; EC2 `ModifySecurityGroupRules` unimplemented; 6 idempotency read-back fidelity gaps; ELBv2 listener Certificates absent. → PRs #463+#466 / `1859adf`.
- **#450–#452** OCI `/v2/` data plane (ECR/AR/ACR). → PR #456 / `8e866c3`.
- **#433–#438/#441–#447** LaunchTemplates; KMS grants/crypto; ECR policy + layer data plane; ECS capacity providers; EC2 instance type offerings; ELBv2 rules; IAM ListPolicyVersions; EC2 VPC/SG filters; CW Logs kmsKeyId; ECS DescribeClusters; IAM ListRoles. → PRs #439+#440+#448+#449.
- **#420/#421/#427/#428/BUG-1470** ACM DNS validation; IAM policy simulation; EC2 ENI ops; position-dependent filters. → PRs #424+#431+#430+#429 / `9e2640a`.
- **#411–#418** KMS rotation/tagging; NAT Gateway; DynamoDB GSIs; ECS Service capacity providers; Application Auto Scaling; EventBridge Scheduler. → PRs #410+#415+#418 / `aa33123`.
- **#359–#410** EBS snapshots; Entra authorize; sim Dockerfile; EC2 AttachVolume; control/data-plane coupling; bleephub /user/teams; Entra groups claim; bleephub OAuth non-conformance. → PRs #361–#401.
