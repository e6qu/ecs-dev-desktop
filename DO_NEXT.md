# DO_NEXT.md — ecs-dev-desktop

> Prioritized next tasks, open decisions, blockers. Update after every task.

---

## Open decisions (need the user)

1. **AWS account/region & data-residency** — **the top blocker.** Gates real Terraform,
   Phase 1 deploy, SSH/proxy real federation, reconciler cron, Phase 8C observability,
   Phase 7, `e2e-aws`.
2. **Domain & DNS owner** — base domain for `*.devbox.<domain>` + cert/DNS owner. Gates
   the identity-aware proxy + ACM.
3. **VS Code distro** — confirm code-server / OpenVSCode + Open VSX (Phase 1 golden image).
4. **Identity-aware proxy** — confirm Pomerium (done on the sim; vs Authentik/in-house).
5. **Heartbeat interval & idle threshold** — scale-to-zero tuning.

Resolved: DynamoDB+ElectroDB · sockerless from source · Fargate managed-EBS · manual
real-AWS on `main` · AGPL-3.0-or-later · Turborepo+pnpm · CASL · dep floor 1440 · admin
observability = derive-now + CloudTrail/CloudWatch (no custom audit store).

## Available now (decision-free — immediate)

- **Teleport `endpoint_url` Enterprise fix** — blocks 2 of 4 remaining CI failures.
  Fix is ~10 lines removed from `lib/services/github.go` in `MarshalOSSGithubConnector`.
  Decision needed: **vendor Teleport** (git submodule, build from source in a Dockerfile,
  same pattern as sockerless) vs **patch file only** (store `.patch`, apply in Dockerfile
  during build, no submodule). Key factor: Teleport is a large Go codebase — build time
  in CI matters. Recommend investigating Teleport's build structure before deciding.
- **Wait for e6qu/sockerless#504** (azure-sim OIDC v2.0 issuer fix) — blocks Pomerium JWT
  assertion test (1 of 4 remaining CI failures). No action on our side until upstream
  implements the fix.

## Done recently

- **CI fixes for PR #54 (round 2):** `pass_identity_headers: true` added to Pomerium
  wildcard route (`infra/proxy/pomerium.yaml`) — required for `X-Pomerium-Jwt-Assertion`
  injection (Pomerium default is false). AWS credentials (`AWS_ACCESS_KEY_ID/SECRET`) added
  to `teleport-auth` in `docker-compose.ssh.yml` — S3 client can't sign requests without
  them; removed dead `TELEPORT_S3_ENDPOINT` (not a Teleport env var, 0 occurrences in
  codebase). Teleport Enterprise blocker documented in `BUGS.md`. AGENTS.md rule 9 added:
  upstream issues only in `github.com/e6qu/sockerless`.
- **CI fixes for PR #54 (round 1 — vuln-scan + terraform-sim + e2e SSH harness):** trivy
  `.trivyignore.yaml` + `trivyignores:` for bleephub admin token false positive; `assert_cloudtrail`
  switched to server-side `--lookup-attributes` (avoids 50-event cap); `bucket-init` init
  container pre-creates `edd-e2e-sessions` S3 bucket; `audit_sessions_uri` moved to
  `teleport.storage` (Teleport 17+ config change). 12/14 CI jobs green.
- **CloudTrail-based resource + functional tests:** integration tests verify specific CloudTrail event content (CreateCluster in `recent()`, newest-first ordering, `LookupAttributes` filter); workspace-lifecycle e2e asserts RunTask/StopTask/CreateSnapshot in CloudTrail and via `CloudTrailAuditSource`; reconciler e2e test 3 checks scheduler-fired RunTask in CloudTrail; `terraform-sim` CI step now audits 8 provisioning events post-apply + probes DynamoDB write/read, CloudWatch Logs write/read, ECS task-def registration against the live provisioned infra. If any new assertion exposes a sim gap, it will be filed upstream per §6.8.
- **Full Teleport GitHub OAuth headless sim test (submodule → 0b9af6e):** sockerless PRs #491 + #492 fixed `cron()` evaluation, `N/step` parsing, and bleephub OIDC discovery. New `ssh-connect.e2e.ts` test 5: seeds bleephub (`acme` org + `platform-admins` team + `admin` member), drives `Teleport → bleephub ?auto=1 → Teleport callback` redirect chain headlessly, asserts `tctl get user/admin` shows `edd-ssh-e2e` role. No open sockerless blockers remaining.
- **Phases 3/4/5 sim-testable (PR #55):** Reconciler container (`src/run.ts` + `Dockerfile` esbuild bundle); EventBridge scheduler→ECS→container e2e (`reconciler-container.e2e.ts`); authenticated Pomerium proxy-pass (`pomerium-authed.e2e.ts` — full OIDC flow via azure-sim → `X-Pomerium-Jwt-Assertion`); Teleport S3 session recording + GitHub connector (`ssh-connect.e2e.ts` additions); `docker-compose.ssh.yml` gains `sockerless-aws-ssh` + `bleephub-ssh`.

- **Phase 8C: CloudTrail + CloudWatch Logs adapters (PR #53).** `@edd/cloudtrail-audit` (`CloudTrailAuditSource`) + `@edd/cloudwatch-logs` (`CloudWatchLogSource`) — endpoint-only, sim-proven, integration tests in `test/`. `apps/web` selects real adapters via `AUDIT_PROVIDER=cloudtrail` / `LOG_PROVIDER=cloudwatch` / `EDD_APP_NAME`. Terraform injects all three. Phase 8 fully closed. Corrected the DO_NEXT misclassification: these were not AWS-gated; the sockerless sim has `cloudtrail.go` + `cloudwatch.go`.

- **Golden workspace image + idle-agent + real adapter wiring (PR #52).** `infra/images/workspace/`: Node 20 + OpenVSCode Server v1.109.5, idle-agent shell script (heartbeats every 120s), tini PID-1. `EcsComputeProvider.runTask` injects `EDD_WORKSPACE_ID`/`EDD_CONTROL_PLANE_URL`/`EDD_AGENT_TOKEN` (HMAC-SHA256) per task. Heartbeat route accepts agent machine-auth (`Authorization: Bearer <token>`) in addition to session auth; 4 new integ tests. `COMPUTE_PROVIDER=ecs` env var switches `apps/web` from fakes to real `EcsComputeProvider` + `Ec2StorageProvider`; fails loudly if required ECS vars are missing. Terraform module injects `COMPUTE_PROVIDER`, `CONTROL_PLANE_URL`, `ECS_SUBNETS`, `ECS_SECURITY_GROUPS`, `ECS_EBS_ROLE_ARN`; `EDD_AGENT_SECRET` via `secret_environment`. `DEFAULT_WORKSPACE_MOUNT_PATH` → `/home/workspace`.

- **IAM policy simulation + fck-nat ENI ops — sim gaps #427/#428/#BUG-1470 resolved upstream
  (PRs #431/#430/#429); submodule → `9e2640a`.** The `terraform-sim` CI job now runs four
  configurations every PR: default stack (with **IAM least-privilege assertions** between
  apply and destroy — `simulate-principal-policy` verifies `dynamodb:PutItem` allowed,
  `s3:GetObject` implicitly denied, `ec2:DeleteVolume` tag-condition enforced); **fck-nat
  NAT-instance** (`nat_mode=instance`); and the DNS/TLS path. Module got `reconciler_task_role_arn`
  output. Also BUG-1470 (EC2 position-dependent filters — `DescribeNatGateways`/`DescribeSubnets`/
  `DescribeRouteTables` ignored non-first filters) fixed upstream as part of #429.
- **Simulators over HTTPS (TLS) — mock-free Entra auth + SSH (`e2e-https` job).** All three
  sockerless sims serve over TLS (`gen-sim-tls-cert.sh` → self-signed CA in gitignored
  `temp/sim-tls`; `docker-compose.https.yml`; `EDD_SIM_SCHEME=https` flips `@edd/config`).
  The Entra login→group→role smoke (Graph + ROPC) runs over HTTPS with real CA trust
  (`NODE_EXTRA_CA_CERTS`, **no `--insecure`** — fails without the CA), and SSH connect +
  authz-deny runs against the real Teleport cluster. Config-only (§6.8); no upstream gaps.
- **Terraform platform module + full non-mocked sim apply in CI.** Reusable
  Terraform/Terragrunt module for the whole stack (VPC + NAT [managed or **fck-nat**], KMS,
  DynamoDB single-table w/ GSIs, ECR, ECS cluster + Fargate service + autoscaling, ALB +
  optional ACM/Route53, scheduler, IAM, logs) with examples + README. The `terraform-sim`
  CI job **applies + destroys the entire stack against the sockerless sim every PR**
  (`55 added → 55 destroyed`, endpoint-only). The four-round upstream saga that unblocked it
  (#411→#410, #413/#414→#415, #416/#417→#418) is fully fixed; submodule → `aa33123`. Plus a
  portable `check-branch-current.sh` (fast-forward guard, pre-commit + CI) and the
  heartbeat-route 409 test.
- **Error channel to the UI + code-health gates.** `@edd/api-client` surfaces the server's
  typed `{error}` message as `ApiError` (strict parse, **no fallback** — fails loudly).
  Added **knip** (dead code) + **jscpd** (copy-paste, 1% threshold) to CI (`code-health`
  job) + pre-commit; removed the dead code knip found and deduped jscpd's clones
  (`unwrap()`, `loadOwnedWorkspace` reuse, `persist`↔`toWorkspaceDetail`, e2e↔provider).
- **Type system / de-flaking (3 PRs, all merged/done).** PR1: compile-time exhaustiveness
  (`assertNever`, `Record<Union,_>` literals — fixed `tallyWorkspaceStates` drift and
  `Record<string,_>` quota → `Record<Role,_>`) + `expectTypeOf` contract↔domain alignment.
  PR2: shared typed `data-testid` registry — Playwright locates by id and asserts on typed
  `data-*` attributes, not rendered text. PR3: harness determinism — `waitForDynamo` (in
  `@edd/db`, called by `ensureTable`/`dropTable`) makes the integ bootstrap poll DynamoDB
  to readiness instead of racing container startup (portable, no container health-check
  needed), plus retry/backoff on the integration job's sim bring-up.

- **Typed error channel (`Result` + `DomainError`) — complete.** Domain failures are now
  data returned in `Result<T, DomainError>` (never thrown), mapped to HTTP by one
  exhaustive `kind→status` table; a forgotten mapping is a compile error. Part 1
  (foundation, `CatalogService`, base-image/create routes); part 2 (state machine +
  workspace domain fns + `WorkspaceService` + the five workspace routes + the reconciler;
  removed the `InvalidTransitionError`/`WorkspaceNotFoundError` classes and every bare
  `throw new Error`). The reconciler now **skips and counts** a stop/snapshot that loses a
  state race instead of aborting the sweep. Behaviour-preserving (statuses unchanged).

## Available now (decision-free — after Teleport fix)

- **Merge PR #54** once CI is fully green.
- **Phase 8 — admin console** (`docs/admin-ui-design.md`): ✅ **Complete (8A + 8B + 8C).**
- **Phases 3/4/5 sim-testable** — ✅ done (PR #55). GitHub connector + OAuth blocked by Teleport Enterprise restriction until fixed.
- **idle-agent** — ✅ done (ships in the golden image, PR #52).

> Once PR #54 merges, the highest-value lever is the **AWS account/region decision** (#1).

## Blocked

- **On AWS (#1):** the `infra/terraform` module is **built and sim-apply-proven in CI**
  (full stack incl. the DNS/TLS path: VPC/ECS/ECR/DynamoDB+GSIs/KMS/IAM/ALB +
  ACM/Route53/HTTPS) — what's AWS-gated is the **real apply** (account + remote state
  backend), golden image + real Fargate deploy, wiring `apps/web` to real adapters,
  Teleport/Pomerium real federation + DNS, reconciler cron, Phase 8C (CloudTrail/CloudWatch/
  Cost), Phase 7, `e2e-aws`.
- **On DNS (#2):** real `*.devbox.<domain>` routing + ACM (the module path is sim-proven;
  the _real_ hosted zone + cert issuance is AWS/registrar-gated).
- **On upstream sockerless:** One open blocker: **#504** azure-sim OIDC v2.0 issuer mismatch
  (blocks `pomerium-authed.e2e.ts` JWT assertion test). (#496/#497/#498 fixed in PR #500
  submodule `fc03b15`; #493/#494 in PR #495 `def45a1`; #489/#490 in PR #492 `0b9af6e`;
  #491 in `dd4e717`)
- **On Teleport `endpoint_url` (gravitational/teleport#67533):** `MarshalOSSGithubConnector`
  rejects non-github.com `endpoint_url` in all OSS builds since v14. Blocks two Phase 4 tests
  (GitHub connector creation + GitHub OAuth login in `ssh-connect.e2e.ts`). Fix: vendor/patch
  Teleport. See `BUGS.md`. (Note: per AGENTS.md §0 rule 9, issues are filed only in
  `e6qu/sockerless` — this is documented here as a blocker, not a filed upstream issue.)
- **VS Code distro:** resolved → **OpenVSCode Server** (MIT, Gitpod). Golden image built.

## Working notes (durable)

- **Sim = sockerless, endpoint-only (HARD RULE, §6.8).** Whole project — product code
  _and_ tests/fixtures — differs from real cloud by **endpoint/base-domain only**.
  Allowed: `AWS_ENDPOINT_URL`, `AUTH_GITHUB_API_URL`, Entra authority, `entraSim`/`awsSim`/
  `bleephub` base URLs. **Not allowed:** `/sim/...` endpoints, hardcoded seed tokens/values,
  non-standard endpoints (e.g. `POST /user/orgs`), branches/fallbacks. If the sim/bleephub
  **diverges from the real API/behaviour** in something that matters, **file a
  non-conformance upstream and halt** — never adapt the test around it. (A sim that
  _accepts_ your call can still be non-conformant — audit behaviour vs the real API.)
- **Web e2e quirks:** Playwright runs against `next start` (Turbopack **dev** hydration is
  unreliable headless). Workspace TS packages need listing in `next.config`
  `transpilePackages`; the browser's `fetch` must be `bind`-ed. Auth in the browser uses
  the **cookie** dev-auth shim (`edd-dev-user`/`edd-dev-role`, gated on `EDD_DEV_AUTH`).
- **DynamoDB Local readiness** races first integ run; re-run or wait for `--wait` health.
- **check-deps churn:** "latest ≥1-day-old" gate goes stale mid-PR (esp. on date rollover)
  — `pnpm update --latest -r` + commit, and `terraform providers lock -platform=linux_amd64
-platform=darwin_arm64` for the TF lock.
- **CI registry rate limits:** harness bring-up steps retry/backoff (public.ecr.aws/Docker
  Hub on shared runner IPs).
- **Pinned versions:** Teleport `18.6.2`, Pomerium `0.32.2`, `@playwright/test` ^1.60.
