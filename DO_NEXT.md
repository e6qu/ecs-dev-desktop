# DO_NEXT.md — ecs-dev-desktop

> Prioritized next tasks, open decisions, blockers. Update after every task.

---

## Open decisions (need the user)

0. **opencode is BLOCKED — no clean fix exists; decide the path forward.** opencode renders
   BLANK in prod (root-caused + fix-attempted 2026-07-12; full evidence in `BUGS.md`): the proxy
   delivers everything (all APIs 200, SSE streams, app mounts), but opencode's SolidJS **path
   router** matches no route under the `/w/<id>/` proxy prefix, so only its out-of-`<Routes>`
   chrome paints. Base-path virtualization was ATTEMPTED and is **technically impossible** —
   `location.pathname`/`href` are [Unforgeable] Web-IDL properties (non-configurable; `location`
   can't be reassigned), so an inline shim cannot make the router perceive `/`. `opencode-ai@1.17.15`
   has no `--base-path`/`BASE_PATH` option (open upstream feature request; a third-party fork adds
   it). Options: **(a)** track upstream base-path support and adopt when released; **(b)** vendor
   the `prokube/pk-opencode-webui` prefix-aware fork (supply-chain + maintenance cost); **(c)** drop
   opencode as an offered editor kind (keep openvscode/monaco/terminal) so users aren't handed a
   broken option; **(d)** per-workspace subdomain for opencode only (contradicts the §1
   no-wildcard-DNS/TLS decision). Recommendation: (c) now + (a) to unblock later.

1. **Heartbeat interval & idle threshold** — scale-to-zero tuning. The knobs
   now exist (`EDD_HEARTBEAT_INTERVAL_S` injected into workspace tasks;
   `EDD_IDLE_THRESHOLD_MS`/`EDD_SNAPSHOT_INTERVAL_MS`/`EDD_EARLY_SNAPSHOT_INTERVAL_MS`/
   `EDD_EARLY_SESSION_MS`/`EDD_GC_GRACE_MS` on the reconciler) — the open decision is
   only the production default values.

Resolved: DynamoDB+ElectroDB · sockerless from source · Fargate managed-EBS ·
manual real-AWS on `main` · AGPL-3.0-or-later · Turborepo+pnpm · CASL · dep floor
1440 · admin observability = derive-now + CloudTrail/CloudWatch · OpenVSCode Server ·
OpenSSH registered-key auth (no CA) · **identity-aware proxy — decided 2026-06-20: Pomerium
DROPPED.** The external Pomerium proxy + the standalone `workspace-gate` PEP/PDP were removed and the
browser→editor proxy was **folded into the Next.js control-plane app** — path-based single domain
(`app.<domain>/w/<id>/`), authorized in-process by the Auth.js session (uid-ownership/admin); no
wildcard DNS/TLS, no PDP round-trip, no gate machine-auth (`apps/web/server.ts` +
`apps/web/lib/workspace-proxy.ts`; see `WHAT_WE_DID.md` 2026-06-20 + `BUGS.md`).
**AWS account/region — DONE (2026-07-05/06).** Region `eu-west-1`, deployed as
`edd-prod`. **Domain & DNS — DONE.** `e6qu.dev` registered (Namecheap); a delegated
Route53 zone `edd.e6qu.dev` hosts `app.edd.e6qu.dev` (control plane) and
`ssh.edd.e6qu.dev` (SSH front door), NS-delegated from the Namecheap-hosted apex
so `e6qu.dev` itself stays free for other future use. Real production stack is
**live**: see `STATUS.md` and `WHAT_WE_DID.md` 2026-07-05/06 for the full deploy
narrative (9+ real bugs found and fixed along the way, all in `BUGS.md` →
Resolved (repo)). **Claude/Codex workspace type direction — DONE (2026-07-10).**
EDD did not ship separate Claude Code or Codex workspace types because no
first-party EDD-hostable local browser UI was verified for either product.
Claude and Codex were shipped as CLIs inside the generic `terminal` workspace
type instead; any future vendor web integration needs a newly verified
first-party local browser command/bundle and an explicit product decision.

---

## Scale-to-zero DoS / cost-amplification hardening — notes (2026-07-11)

Recorded decisions from the `harden/scale-to-zero-security` review (no user decision
needed — logged so the boundary is explicit):

- **Shield Advanced — OUT OF SCOPE (cost).** L3/L4 volumetric absorption + the WAF
  DDoS cost-protection SLA would need AWS Shield Advanced (~$3k/mo + data fees). Not
  added. The current edge defenses (CLOUDFRONT WAF managed common rule set + per-IP
  `cloudfront_rate_limit` rate-based BLOCK, wake Lambda `reserved_concurrent_executions`,
  AWS_IAM+OAC-locked Function URL) cover the L7/application + wake-amplification cost
  vectors without it. Revisit only if a real volumetric attack or a billing scare
  justifies the subscription.
- **Cached `custom_error_response` for the cold-start placeholder — CONSIDERED, NOT
  ADOPTED.** Caching the wake placeholder at the edge to spare repeat Lambda invokes is
  infeasible without breaking wake/recovery: the wake Lambda is itself the
  scale-from-zero trigger (a cached error page would never wake the service); the
  navigation placeholder is a 200 (a status-keyed error response never matches it); and
  the `/api/readyz` poll is answered 503 on purpose, so caching that 503 would serve a
  stale "still down" after recovery. Managed-CachingDisabled (required for the dynamic
  app + WebSocket path) also forbids caching on the shared behavior. Rationale is
  inline in `cloudfront.tf` (default_cache_behavior NOTE). Wake-path cost is bounded
  instead by the pre-failover WAF rate block + reserved concurrency + a tiny/idempotent
  Lambda.

---

## Code-review remediation (codex 2026-06-19) — DONE (merged #129, Phase 9)

The deep `codex` review surfaced 12 findings (4 Critical, 3 High, 4 Medium/Low) — **all remediated and
merged in #129**, re-verified against the merged code. Detail now lives in `BUGS.md` → Resolved (repo).
The previously-deferred cross-region EBS snapshot DR flow was pulled in (sim-validatable via
sockerless#602). `CONNECTION_TOKEN` injection — once parked on the future DYNAMIC wake-on-connect gate —
**shipped 2026-06-20** with the in-app path-based editor proxy: the control plane injects the per-workspace
connection token via Secrets Manager and the proxy hands the session-authorized browser the token on the
initial document navigation (see `BUGS.md` → Resolved + `WHAT_WE_DID.md` 2026-06-20).

Only genuinely AWS-account-gated work (real `terraform apply`, real DNS/ACM, real IdP federation, 200+
load, live `e2e-aws` enforcement) stays under decision #1 above — that is an external decision, not a
deferral by choice.

## Available now (decision-free — immediate)

- **Wire the admin traffic filter to real WAF coordinates (Terraform + operator).**
  The admin traffic-filter console + backend shipped 2026-07-11
  (`/admin/traffic`, `TrafficFilterService`, `apps/web/lib/waf-applier.ts`): it
  persists an allow/block policy (IP CIDR / country / ASN / cloud-hoster preset /
  block-anonymous) and applies the compiled rules to the live CLOUDFRONT-scope
  WAFv2 Web ACL. `getState` works with no WAF env, but APPLY needs four env
  coordinates on the control-plane task: `EDD_WAF_WEB_ACL_ID`,
  `EDD_WAF_WEB_ACL_NAME`, `EDD_WAF_IP_SET_ID`, `EDD_WAF_IP_SET_NAME` (scope fixed
  CLOUDFRONT → us-east-1). Terraform must provision (or already provisions) the
  CloudFront-scope Web ACL AND an associated IPSet (currently the prod WAF may
  have no managed IPSet), then export those ids/names into the task env. Until
  then, a Save in the console fails loud with a 5xx naming the missing coordinate
  (recorded on the state, visible in the UI) — by design, not a bug.

- **Traffic filter — IPv6 support needs a second (IPV6) WAF IPSet.** The core now
  REJECTS IPv6 CIDRs (`validateTrafficFilterPolicy`) because a WAFv2 IPSet holds a
  single address family and the live WAF is provisioned as one IPv4 IPSet, so an
  IPv6 entry would only fail at apply time. To support IPv6: Terraform provisions a
  second IPV6-family IPSet + exports its id/name as new coordinates; the applier
  splits `ip` rules into a v4 IPSet and a v6 IPSet reference; the validator drops the
  IPv6 rejection. Until then IPv4-only is the honest, fail-loud behavior.

- **DONE 2026-07-11 (evening):** #222's `ecs:TagResource` IAM grant + the
  10-second LB target-group health checks were applied to prod via a TARGETED
  `terraform apply` (local authoritative state; S3 backend bucket is empty).
  Workspace launch verified live (OpenVSCode renders; zero `ecs:TagResource`
  denials). #223 merged and deployed (`80592bd`). The
  `feat/admin-snapshots-and-boyscout` branch added the admin snapshot console,
  two scale-to-zero correctness fixes, a UI/UX layout pass, and a Terminal
  smoke-selector fix. Remaining OPERATOR-ONLY items (blocked as shared-account
  mutations, run them yourself):
  - Activate the cost-allocation tag: `aws ce update-cost-allocation-tags-status
--cost-allocation-tags-status TagKey=edd:cost-scope,Status=Active` (now
    discoverable in Billing), then confirm `/admin/costs` reads `edd-alpha`-scoped
    Cost Explorer data.
  - Purge the 5 stale reconciler-DLQ messages (they are old RunTask payloads for
    reconciler task-def revision `:6`, keeping the DLQ alarm in ALARM): `aws sqs
purge-queue --queue-url <edd-prod-reconciler-dlq> --region eu-west-1`.
  - Use the new `/admin/snapshots` console to purge the 60 unattributed retained
    snapshots (all are unreferenced retained orphans), then confirm the next Cost
    Explorer day drops EC2-Other snapshot spend.
  - Set `monthly_budget_usd` (a dollar amount) to enable the authored AWS Budgets
    guardrail + its 80%/100% SNS alarms.
    A FULL `terraform apply` is still NOT safe (it re-registers the
    control-plane/reconciler task defs the release workflow owns and would roll
    ssh-gateway back a revision) — keep applying by target.

- **After PR #222 merges, `terraform apply` the module, then confirm workspace
  launch works in prod.** The `ecs:TagResource`-on-task-definition grant only lands
  via Terraform (the release workflow rolls images, not IaC). Apply from the
  authoritative remote state
  (`s3://edd-tfstate-edd-prod/ecs-dev-desktop/edd-prod/terraform.tfstate`), then
  create one workspace and confirm it reaches `running`/`functional=ok` instead of
  the `ecs:TagResource` denial. Until this apply runs, prod workspace launch stays
  broken and `post-deploy-smoke` will still fail on the workspace step (the smoke's
  catalog-rollout timing is fixed, but the launch itself needs the IAM grant). The
  same apply also picks up the still-outstanding 10-second target-group
  health-check drift.

- **Verify PR #222's fixes live after merge + apply.** Confirm: a stopped
  workspace no longer carries `shareEnabled` (spectate requires re-consent);
  `/admin/costs` shows nonzero cost for a terminated-but-unpurged workspace and for
  a undeleted+rerun workspace, and the AWS section shows a "cached — as of HH:MM
  UTC" stamp without repeated Cost Explorer calls; the reconciler's orphan-secret
  reaper deletes the ~170 stale `edd/workspace/*` secrets over subsequent sweeps
  (watch Secrets Manager count fall); the empty workspace list converges when a
  workspace is created out-of-band; and a viewer persona sees no lifecycle buttons.

- **Retry `edd:cost-scope` cost-allocation tag activation — now UNBLOCKED.** AWS
  Billing has discovered the key (`list-cost-allocation-tags` returns it as
  `Inactive`), so `ce update-cost-allocation-tags-status TagKey=edd:cost-scope,
Status=Active` should now succeed (it previously threw `ValidationException: Tag
keys not found`). This is a shared-account billing change — run it as the
  operator, then confirm `/admin/costs` reads CE data scoped to `edd-alpha`.

- **Clear the remaining live cost/ops debris (operator decisions).** The live
  audit (2026-07-11) still found: 5 stale messages in `edd-prod-reconciler-dlq`
  (its alarm is in ALARM — purge if they are the known old inactive-taskdef
  messages); 60 EDD-managed retained snapshots without `edd:workspace-id` (decide
  keep-vs-delete per the data policy); and no AWS Budget because
  `var.monthly_budget_usd = 0` — set a dollar amount to enable the already-authored
  `aws_budgets_budget.monthly` guardrail + its 80%/100% SNS alarms.

- **After this branch deploys and the golden image rebuilds, run the strengthened
  deployed workspace smoke and inspect screenshots/artifacts.** It now must prove
  OpenVSCode has a visible top-level `EDD home` link, the real File menu opens
  from an actual click, Monaco/Terminal/opencode all click back to `/workspaces`,
  and Terminal performs default-tab command execution, new tab, tab switching,
  and tab close. Do not accept health endpoints, ECS deployment completion, or
  static screenshots as a substitute. The local Terminal web UI was exercised
  with Playwright, but host Node `v26.5.0` plus `node-pty@1.1.0` failed PTY
  spawn with `posix_spawnp failed`; the UI was fixed to show that failure loudly,
  and the full command/tab proof must run in the intended Node 22 golden-image
  runtime.

- **After the structured-cost-attribution fix deploys, verify `/admin/costs` in
  production.** Confirm the report remains available, the legacy workspace
  appears in the explicit unpriced warning, and a newly created workspace is
  priced from structured audit resources after deletion. Do not backfill the
  legacy workspace with guessed sizing.

- **After deploy, verify the current branch's production fixes as one skeptical
  browser flow.** Confirm `/admin/costs` no longer reports undefined sizing after
  v2 rollup regeneration; open circle-i dialogs over cards and verify they remain
  above the topbar/page; drive the browser offline and verify the topbar refresh
  control appears and automatic recovery works; then open a newly built
  OpenVSCode workspace and inspect the visible real File menu, EDD return link,
  and terminal command output. Deployment/health success alone was not enough.

- **Stage workspace provisioning/startup performance work and expose it to
  admins.** The current real launch path contains several potentially expensive
  phases: per-workspace Secrets Manager upserts, task-definition
  registration/cache lookup, ECS `RunTask`, Fargate placement/ENI assignment, ECR
  image pull, managed EBS volume attach or snapshot hydration, editor process
  boot, and first successful proxy HTTP/WebSocket connection. Do the work in this
  order:
  1. **Instrumentation first:** emit phase timings for create and wake:
     secret-upsert, task-definition, RunTask API, ECS pending/provisioning,
     managed-EBS attach/hydrate, container start, editor readiness, and proxy
     first-success. Include workspace id, workspace interface, image ref, resource
     sizing, fresh-vs-snapshot launch, and failure phase.
  2. **Admin metrics UI:** expand the EDD admin metrics/health surfaces to show
     p50/p90/p99 provisioning and wake latency by workspace interface and image,
     latest slow starts with phase breakdowns, failure counts by phase, and links
     to the workspace/session/log context. The UI must distinguish "ECS task
     running" from "editor reachable".
  3. **Image-pull reduction:** split golden images by workspace interface when
     measurements show image pull dominates, keep shared layers stable, and make
     editor-specific layers last. Verify ECR layer reuse and screenshot smoke for
     OpenVSCode, Monaco, Terminal, and opencode.
  4. **Launch-path API reduction:** if task-definition or Secrets Manager latency
     is material, redesign for stable reusable task definitions and pre-created
     per-workspace secrets without weakening token revocation, no-fallback auth,
     or fail-loud behavior.
  5. **Stopped-workspace wake tuning:** measure snapshot-hydration cost by disk
     size and workspace type, then decide whether to change default disk sizing,
     avoid unnecessary shutdown snapshots when a fresh snapshot already exists, or
     add a short paid warm-idle window before scale-to-zero.
  6. **Policy decisions from evidence:** only consider cost-bearing warm pools,
     longer warm-idle windows, or SOCI/lazy-loading after production phase data
     shows they beat the simpler image/task-definition fixes.

- **After this cost/convergence branch merges, rerun release, golden-images, and
  post-deploy-smoke and inspect artifacts again.** Confirm production
  `/api/healthz` reports the merge SHA, the golden image exists in ECR, the
  enabled catalog rolls to that same tag, and the smoke no longer times out on
  stale catalog state. If rollout fails, inspect the new
  `catalog-rollout-failure.json` artifact before making a code change.

- **After this branch deploys, verify `/admin/costs` shows both accounting
  layers.** The page should show workspace lifecycle spend from the ledger and a
  separate AWS account Cost Explorer section. Confirm it does not render `$NaN`,
  and confirm a missing/denied `ce:GetCostAndUsage` permission fails visibly
  rather than falling back to configured rates or blank values.

- **Retry AWS Cost Allocation Tag activation for `edd:cost-scope`.** The live
  resources were tagged with `edd:cost-scope=edd-alpha`, but AWS Billing had not
  yet discovered the new key: `ce update-cost-allocation-tags-status` returned
  `ValidationException: Tag keys not found: edd:cost-scope`, and
  `list-cost-allocation-tags` returned no matching tag. Retry activation after
  Billing's tag inventory catches up, then verify `/admin/costs` can read
  Cost Explorer data scoped to `edd-alpha`. Do not add an account-wide fallback.

- **Run an explicit cleanup operation for existing retained snapshots only after
  the operator chooses the data policy.** The live audit found 59 EDD-managed
  retained snapshots, all missing `edd:workspace-id`, so the branch made future
  snapshots attributable but did not delete existing retained data. If the
  decision is "no legacy data matters", delete the existing EDD-managed retained
  snapshots explicitly and verify the next Cost Explorer day drops EC2-Other
  snapshot spend. If any data might matter, keep them until manually mapped.

- **Verify runtime secret GC after deploy.** Live AWS had many active
  `edd/workspace/<id>/{agent,connection}` Secrets Manager secrets while no
  workspace tasks were running. The branch changed retention to task-referenced
  runtime ids only; after the reconciler runs, confirm old workspace secrets are
  deleted and Secrets Manager's daily cost starts falling.

- **Resolve the remaining live cost/audit debris explicitly.** The live audit
  still found 5 messages in `edd-prod-reconciler-dlq`, two untagged associated
  Elastic IPs, retained EDD snapshots without historical workspace attribution,
  stale workspace runtime secrets pending the new GC, and no AWS Budgets. The
  operator chose to delete non-EDD leftovers, and the cleanup removed the
  sockerless S3 buckets, sockerless EFS filesystem/access points, sockerless/skls
  CloudWatch log groups, old sockerless ECS task definitions, the non-EDD ECR
  cache repository, and empty default VPCs/subnets/internet gateways across
  enabled regions. The follow-up tagging branch tagged the two ALB EIPs, the EDD
  Terraform state bucket, the DynamoDB lock table, Route53 zone, EDD IAM
  roles/policies, runtime secrets, and retained snapshots with
  `edd:cost-scope=edd-alpha`. Decide whether the remaining EDD-adjacent
  resources are intentional, then import or delete them; do not let them stay
  undocumented.

- **After this release-manifest fix merges, rerun `release` and confirm actual
  deployment.** PR #217's post-merge release failed before deployment because
  the direct-push BuildKit path still used `docker manifest create` against a
  pushed `-amd64` manifest list. After the fix merges, verify the release
  publishes control-plane and ssh-gateway tags, deploys ECS, and production
  `/api/healthz` reports the new merge SHA rather than the currently deployed
  `3886482cd83f`.

- **After this follow-up branch merges, rerun release, golden-images, and
  post-deploy-smoke and inspect artifacts again.** Confirm the `golden-images`
  workflow uses direct BuildKit push and publishes
  `edd-prod/golden/omnibus:<merge-sha>` without the previous runner-disk
  `no space left on device` failure. Confirm the production catalog rolls to the
  merge SHA and the screenshot smoke reaches all workspace editor checks.

- **After this follow-up branch merges, verify the simplified workspace catalog
  in production.** Create OpenVSCode, Monaco, Terminal, and opencode workspaces
  from the rolled golden image. Confirm the UI no longer offers Claude Code or
  Codex workspace types, Terminal opens the multi-tab terminal surface under
  `/w/<workspace-id>/`, and both `claude` and `codex` commands are present in
  that terminal. Confirm opencode still renders through the path proxy.

- **Decide whether Claude Remote Control should be a separate launch/link flow.**
  It was verified as an official Anthropic harness, but its browser surface is
  `claude.ai/code`/mobile, not EDD `/w/<workspace-id>/`. It requires per-user
  claude.ai login/subscription and Team/Enterprise enablement, keeps a local
  Claude process running in the workspace, and uses outbound HTTPS only. If used,
  EDD should present it honestly as "Start Claude Remote Control" plus the
  vendor session URL/status, not as "Claude Local Web UI".

- **Verify production invitation mail configuration after merge/deploy.** The app
  now showed explicit admin errors instead of a raw Next digest, but sending still
  required real `EDD_PUBLIC_APP_URL`, `EDD_EMAIL_FROM`, `AWS_REGION`, SES sender
  verification, and `ses:SendEmail`. Confirm the live ECS task definition carries
  the mandatory env and that creating/reissuing an invitation sends email; if SES
  is intentionally not configured, the admin UI must show the explicit failure.

- **Verify production costs after merge/deploy.** Confirm `/admin/costs` no
  longer renders `$NaN`. If old audit/rollup data is malformed, the page should
  fail visibly with "Cost report unavailable" and the underlying bad persisted
  row should be repaired or deleted by explicit operational action.

- **After this dependency/local-Docker follow-up branch is opened, watch CI and
  merge only after the same checks pass there.** Local verification now rebuilt
  and started the sockerless AWS simulator with Docker Compose, then passed
  `pnpm --filter web test:pw` 19/19. The branch also moved runtime AWS SDK
  clients into `apps/web` runtime dependencies and made `check-deps`
  peer-aware for the verified TypeScript 7 / `typescript-eslint@8.63.0` mismatch.
  Inspect CI for the frozen install, `check-deps`, lint/build/test, and
  Playwright jobs before merge.

- **After this admin/auth/image-source branch merges, rerun release,
  golden-images, and post-deploy-smoke and inspect artifacts again.** PR #214
  deployed and built `omnibus:7197f30de9d9`, but `post-deploy-smoke` run
  `29020812950` failed because the production catalog still pointed at
  `omnibus:d063fea1ec78`. The branch added GitHub commit polling to the
  long-lived image-source sweep, made every configured branch SHA change build
  golden images, and made the golden-images workflow verify pushed ECR tags.
  After merge, confirm the image-source records exist in DynamoDB, the enabled
  catalog image rolls to the merge SHA, and screenshot smoke reaches all
  workspace editor checks.

- **Verify admin-managed auth in production after merge.** Create a local admin
  account, create/reissue a developer invitation, confirm SES delivery or the
  explicit SES failure, accept the invitation, log in as the developer, create a
  workspace owned by that developer, and confirm an admin can see all
  workspaces. Verify `/admin/users` lists auth sessions and that revoking one
  user's sessions and then all sessions invalidates existing browser cookies.

- **Verify live pricing/IAM in production after merge.** With
  `EDD_AWS_PRICING=1`, confirm `/admin/costs` loads from AWS Price List data
  and fails loudly if `pricing:GetProducts` is missing. Confirm the task role
  includes both `pricing:GetProducts` and `ses:SendEmail`.

- **After this opencode proxy fix merges, rerun release/golden-images/
  post-deploy-smoke and inspect artifacts again.** PR #213 deployed and built
  `omnibus:d063fea1ec78`, but `post-deploy-smoke` run `29014192952` failed on
  opencode after proving screenshots for the then-current workspace types.
  The current branch fixed the opencode base-path rewrite for the verified
  `opencode-linux-x64@1.17.15` bundle patterns and added browser console/
  pageerror/requestfailed diagnostics to screenshot-smoke failure artifacts.
  After merge, confirm screenshots exist for OpenVSCode, Monaco, Terminal, and
  opencode; verify OpenVSCode does not render `Forbidden`, Monaco accepts typing
  after opening a file, Terminal renders the multi-tab terminal surface, and
  opencode renders through `/w/<id>/` without a second public endpoint.

- **Keep Claude/Codex as Terminal CLIs unless a verified vendor browser entrypoint
  appears and the user explicitly changes the product direction.** Local
  verification on 2026-07-10 found Codex app-server as a JSON-RPC protocol
  server, `codex app` as a desktop-app launcher, and Claude Remote Control as a
  vendor-hosted outbound-control flow, not an EDD-hostable web page. Do not build
  an EDD chat UI, do not use Monaco/OpenVSCode as a fallback, and do not add
  Claude/Codex workspace types without the exact vendor-provided browser UI
  command/bundle verified locally.

- **After the current branch merges, rerun the deployed screenshot smoke from
  GitHub Actions and inspect its artifacts.** PR #209 deployed
  `e6b87475c1df` successfully at the ECS/app/image level, but
  `post-deploy-smoke` run `28950258091` exposed that the screenshot smoke still
  bypassed the real browser token-handoff path and that Monaco could still show
  `Cannot edit in read-only editor`. The current branch made the proxy reject
  stale editor-token cookies by value, changed the screenshot smoke to open
  `/w/<id>/` directly with only the EDD session cookie, fixed screenshot
  artifacts/diagnostics, and removed Monaco's read-only editor initialization.
  PR #210 CI also proved the shared Playwright install action could time out
  while fetching apt font packages; the current branch changed Playwright setup
  to install Chromium only in CI smoke/browser workflows, and PR #210's rerun
  passed every CI job after that fix.
  After merge, watch `release`, `golden-images`, and `post-deploy-smoke`;
  confirm the artifact contains screenshots for all four current workspace types
  and specifically verify OpenVSCode does not render `Forbidden`, Monaco accepts
  typing after opening a file, Terminal renders the multi-tab terminal, and
  opencode renders.
- **Apply/verify Terraform drift for fast health checks.** The source expected
  10-second ALB/NLB target-group health checks, but live AWS still showed
  30-second intervals after the image-only release. Apply the Terraform stack from
  the authoritative remote state, then confirm the live target groups match the
  source and deployment convergence time moves toward the 1-2 minute target. The
  expected remote state object still needed operational confirmation/migration at
  `s3://edd-tfstate-edd-prod/ecs-dev-desktop/edd-prod/terraform.tfstate`.
- **Resolve remaining production alarms and audit debris explicitly.**
  `edd-prod-workspaces-stuck-error` returned to OK after the old errored
  Claude/Codex records were deleted/replaced, but `edd-prod-reconciler-dlq`
  still held old inactive-taskdef messages. Old `session.create` audit events
  lacked resource details and made post-sweep cost rollup fail loudly; delete or
  retain those audit rows only after an explicit human operational decision.
- **Verify resource-sized workspace launches in production after this fix.**
  Creation required/persisted explicit resources with defaults of 0.5 vCPU,
  2 GiB RAM, and 8 GiB disk and UI-selectable limits of 4 vCPU, 16 GiB RAM, and
  64 GiB disk. After the new release, create one default workspace and one larger
  workspace, confirm ECS task definitions carry the selected CPU/memory, confirm
  fresh managed-EBS volumes use the selected size, and confirm cards/details/
  monitoring and cost reports show per-workspace sizing.
- **Spectate cross-replica relay** — v1's relay is per-replica (the spectator
  client retries until it lands on the publisher's replica; works, but retry
  count grows with replica count). Follow-up: an internal replica-to-replica
  bridge (publisher replica advertises itself — e.g. a DynamoDB row with its
  task IP — and subscriber replicas relay through it; needs a tasks-SG
  self-ingress rule on the control-plane port). See `docs/design-public-spectate.md`.
- **Spectate for OpenVSCode sessions** — needs extension-based capture inside
  the `edd-workspace-ui` extension (v1 mirrors Monaco only; Claude/Codex now run
  through OpenVSCode vendor extension UIs, so they would depend on the same
  OpenVSCode capture path).

- **Post-launch backlog — consolidated plan (2026-07-06, sequenced; mirrors the session
  task list).** Already shipped from the original queue: editor home links (extension +
  Monaco tabbar), the terminal-keybinding control (status bar — VS Code has no public
  title-bar API), terminal-open-by-default in both editors, autosave-by-default in both
  editors, the claude/codex remote-OAuth tip, the scale-to-zero double fix (crashed
  reconciler + liveness-recorded-as-activity; 15-min idle threshold), and the cookieValue
  crash fix. Remaining, in order:
  1. **Verify the c814221 deploy** — reconciler actually sweeps (CloudWatch), heartbeats
     carry `active`, an untouched workspace stops after ~15 min with a snapshot. NB: a
     workspace created from the OLD image keeps the old unconditional agent until recreated.
  2. **NewSession follow-up polish** — the rich launcher had radio modes for
     blank/existing repo/public GitHub URL/create repo, GitHub connect for Entra
     sessions, owner namespace selection, one Start button, and redirect to the
     per-workspace status page. Remaining polish was visual/UX only.
  3. **Editor selection at creation**: OpenVSCode | Monaco | Terminal | opencode
     shipped as the current UI/data choice. Claude and Codex are CLIs in the
     Terminal workspace, not separate workspace types.
  4. **Monitoring follow-up**: the card/admin surfaces now showed disk usage and linked
     per-workspace monitoring. Remaining work was richer CPU/memory/disk visualization on
     the compact card, per-workspace snapshot-cost display, disk-increase action
     (ModifyVolume + resize), and any extra chart polish.
  5. **Session/cookie resilience**: server-side, versioned Auth.js session rows
     shipped in the current branch, so old-format JWT cookies force re-login and
     logout revokes the server row. Remaining polish was limited to a user-facing
     "reset cookies" affordance if the persona/user menu still needed it.
  6. **Public read-only spectate** (default-off toggle on the card, incl. mouse/focus/
     keystroke visibility): needs a security design first — share flag + unguessable token,
     read-only proxy path, revocation, audit. Likely Monaco-first (OpenVSCode has no native
     spectate mode).
  7. **Live verifications** once the user recreates a workspace: extension installs from
     Open VSX (EACCES fix should suffice; whitelist only if policy needs it), claude/codex
     paste-code login flows in both editors, and editor-session survival across a
     control-plane deploy (drain window shipped).

- **Third adversarial spec-fidelity probe wave — DONE; CloudWatch probe FIXED + sockerless #767 bump (2026-07-03).** PR #179 merged the sockerless #737 bump and all ten probe slices. PR #180 removes the SQS-receipt workaround and fails loudly. The "SNS delivery succeeded but ReceiveMessage empty" issue was **our bug**: `echo "$raw"` corrupts backslash sequences in the nested-JSON SQS Body (POSIX `echo` interprets `\\`). Fixed with `printf '%s\n'` and proper nested-JSON parsing. The sim was correct all along (sockerless #766 was not a sim bug — closed). sockerless **#767** (`f0d96ec3`) also fixes bleephub team creator auto-maintainer (#763/#765). The later DynamoDB concurrent read/write panic was reported as `e6qu/sockerless#777`, fixed upstream by `e6qu/sockerless#778`, and pinned at `b5126463`. All probe slices pass locally.

- **Verify PR #180 in CI and merge if green.** CI should now pass on all jobs including `terraform-sim`, `e2e`, and `e2e-https`.

- **Await sockerless #765 fix + verification.** Once the bleephub fix lands, re-pin, re-run CI, and merge PR #180 if green.
  mutating controls on the REAL `@edd/authz` `defineAbilityFor` (`DemoControlPlane.canMutateWorkspaces()`),
  so a viewer sees the workspace list read-only (no create form, no start/stop/delete) — the identity
  switcher tells a true CASL story. (2) **Provisioning dwell** — `create` now lands in `provisioning` and
  advances to `running` after a short dwell (`markProvisioned`, the real transition), so the scale-to-zero
  cold-start (the `StateBadge` pulse → "Open IDE appears when ready") is visible. (Boy-scout alongside:
  `persistence.loadState` now validates the top-level SHAPE, not just the version number — §6.5a.)

- **AWS deploy-readiness — DONE (PR #172 merged, 2026-06-28).** Closed every code/docs gap blocking a real AWS deploy that didn't need a user decision: Terraform examples wired for SSH ingress, control-plane Dockerfile builds the reconciler bundle, bootstrap/publish/install/uninstall scripts, `release` workflow, `docs/architecture.md` + `docs/install.md`, multi-arch image publishing convention, golden-image ECR path fix, variant-name alignment, workspace memory bumped to 2048 MiB, and dependency-freshness refresh. The module remains sim-apply-proven; real `apply` is still gated on open decisions #1/#2.

- **Terraform `*.devbox.<domain>` wildcard DNS/TLS resources — REMOVED (2026-06-25, vestigial confirmed).**
  Verified no consumer (the HTTPS listener needs only the `app.<domain>` cert); deleted the wildcard
  Route53 record, the wildcard ACM SAN, `local.workspaces_fqdn`, and `var.workspaces_subdomain`, and
  refreshed the sim assertions (ACM SAN count 2→1; the workspace-wildcard Route53 assert repurposed to the
  SSH wildcard). The SSH base domain (`<ws-id>.<ssh-base-domain>`) is separate — untouched.

- **Admin Quotas page: flag who is at/over their limit — DONE (2026-06-25).** Resolved the role-not-stored
  blocker by persisting `ownerRole` on the workspace at create time (the role is otherwise only known at
  the owner's sign-in): threaded through `@edd/core` Workspace/`provision` → `@edd/db` entity →
  `@edd/control-plane` → the `workspace`/`workspaceDetail` contracts → `fleet-status` →
  `QuotaReportDto.usage`. The page now flags `atOrOver` rows. Forward-only (records predating the field
  have no role) → those legacy rows fall back to the **strictest positive** per-role cap (viewer's 0 cap is
  excluded so it doesn't trivially flag everyone). Admin (unlimited) is never flagged.

- **DynamoDB Local retired from all CI — DONE (2026-06-22).** The integration (#148), **e2e**, and
  **playwright** tiers all run on the sim's DynamoDB now; `@edd/config` `dynamodb.endpoint` defaults to the
  sim; `amazon/dynamodb-local` is gone from `tier2`/`e2e` compose + every CI job (see `STATUS.md`/`BUGS.md`).
  The **only** remaining DynamoDB-Local consumer is the local `pnpm dev` loop — kept deliberately for instant
  startup (the CAS flake only bites under CI concurrency), overridable to the sim. A future cleanup could
  migrate the dev loop too (make the sim part of the default dev substrate) to delete DynamoDB Local
  entirely, but it trades dev inner-loop speed for one fewer image — low priority.

- **Moved two e2e-aws-only proofs onto the sim — DONE (2026-06-21).** Acting on the reframe that a sim gap
  is a slice to implement (not a real-AWS wall): **CloudWatch Metrics EMF→metric extraction** is now
  sim-proven (`@edd/cloudwatch-metrics` `test/emf-metric-sink.integ.ts` — `ListMetrics`/`GetMetricStatistics`
  read back our `EmfMetricSink` doc; closes Phase 8C "Metrics on real AWS"), and the **production recurring
  cron model** is sim-proven (`services/reconciler/src/scheduler-recurrence.integ.ts` — a `rate(1 minute)`
  schedule fires its RunTask target ≥2× and re-arms, vs the one-shot `at()` the container e2e covers). Both
  needed NO upstream slice (the sim already had #604 EMF extraction + the scheduler firing loop). Of the
  follow-on sim-first targets: **IAM call-time enforcement — DONE / PROVEN, deepened to condition keys
  (2026-06-22)**. Filed #657 → fixed by sockerless #659 (action-level enforcement) → extended via #660 (full
  condition-operator evaluator; re-pinned `9a1d4e92`). `packages/storage-ec2/src/iam-enforcement.integ.ts`
  proves both **action** level (`DescribeVolumes` allowed, `CreateVolume` denied with `UnauthorizedOperation`)
  and **condition** level (a region-locked policy allows `CreateVolume` in-region, denies it cross-region via
  `aws:RequestedRegion`). **Follow-up (#661) — DONE (2026-06-25):** sockerless #662 now populates
  RESOURCE/SERVICE-scoped condition keys, so our exact tag/cluster-conditioned grants are proven at the sim
  tier too — `storage-ec2/src/iam-enforcement.integ.ts` adds `aws:ResourceTag/edd:managed` (DeleteVolume on a
  tagged vs untagged resource) and the new `compute-ecs/src/iam-enforcement.integ.ts` adds `ecs:cluster`
  (ListTasks on the granted cluster vs another), both via the shared `@edd/aws-itest-support` helper.
  **Cost dashboard visualization — DONE (2026-06-22)**: a no-dependency
  stacked spend bar on `/admin/costs`. **SSH Slice 3 ingress — terraform DONE + sim-exercised
  (2026-06-26)**: the NLB + TCP:22 listener + target group + SSH-gateway ECS service +
  `*.<ssh_base_domain>` wildcard (`ssh-ingress.tf`, gateway image pinned/immutable, no `:latest`).
  terraform-sim asserts the full ingress (apply + idempotency re-plan both clean, re-pinned `08b7ee71`).
  The four ELBv2/NLB sim gaps it depended on are all fixed upstream — #683 (NLB raw-TCP data plane) + #685
  (TCP-TG Matcher) in #687, #688 (TCP-TG HealthCheckPath) in #690, #691 (stable NLB DNSName) in #692 —
  each found on the idempotency re-plan, one per round. Remaining real-AWS work (live byte-stream loop
  through the NLB, real SSH zone) is gated on decisions #1 (account) / #2 (the SSH zone).

- **Wave-3 adversarial spec-fidelity probes — in progress, two upstream blockers filed.** On `feat/adversarial-probes-wave3`:
  (1) **Route53 DNS probe** (`adversarial-slice-route53-dns.sh`) is written and shellcheck-clean; it fails on the wildcard-CNAME assertion because sockerless `e2fafce6` answers DNS queries with exact-name matching only. Filed **e6qu/sockerless#731**. (2) **KMS encryption probe** (`adversarial-slice-kms-encryption.sh`) is blocked by **e6qu/sockerless#732** (KMS `Encrypt`/`Decrypt` do not perform real encryption or enforce key-policy Deny). Both slices will be enabled/strictened once the respective upstream fixes land.

- **Catalog optimistic concurrency (follow-up to the 2026-06-22 sweep L2).** `CatalogService.update`/`create`
  are last-write-wins (no `version` attribute → two concurrent admin edits of the same base image clobber).
  Accepted for now (admin-only, zero-contention; recorded in `BUGS.md` → Open). The fix is to add a `version`
  attribute to the `baseImages` entity + a conditional write, mirroring the `WorkspaceEntity` version-CAS, with
  a conflict integ test. Low priority.

- **Property-based / fuzz testing — ESTABLISHED + extended (2026-06-21, two sweeps).** `fast-check` is part
  of the suite (now **14 `*.fuzz.test.ts`** over the pure functions); the **cost figure-equivalence** and
  **GC-never-reaps-referenced** safety invariants are property-pinned, along with the state machine, the
  fail-closed/never-throw security parsers, and (second sweep) the **machine-token verifier**
  (total/never-throws/exact, workspace-scoped), the **ssh fingerprint** (canonical-base64-only, collision-free),
  and **timeline/audit instant-ordering**. Extend it as new pure logic lands. The two 2026-06-21 sweeps fixed
  ~26 traced bugs total (the second incl. two HIGH: a fail-closed machine-token verifier that THREW, and a
  reconciler convergence sweep that aborted on one transient per-item error) — see `WHAT_WE_DID.md` +
  `BUGS.md`. Two items recorded under `BUGS.md` → Open (neither a code defect to chase): the cost-model
  teardown-volume approximation, and the iam-preflight IAM-path self-check coverage gap (degrades safely).

- **Reconciler runtime IAM preflight (follow-up to the IAM self-check) — DONE (2026-06-20).** The
  preflight adapter was lifted out of `apps/web/lib/iam-preflight.ts` into a shared package
  `@edd/iam-preflight` (`packages/iam-preflight`); `apps/web` imports it and dropped its now-unused
  `@aws-sdk/client-iam`/`@aws-sdk/client-sts` direct deps. `@edd/core` gained pure
  `summarizeIamPreflight`/`IamPreflightSummary` + metric `METRIC_IAM_PREFLIGHT_DENIED`. The reconciler
  (`services/reconciler`) now runs `iamPreflight(env, "reconciler")` at startup and emits the
  denied-action-count metric + a structured log (non-fatal; degrades to unknown), factored into a
  unit-tested `reportIamPreflight`.

- **User-registered SSH keys + per-workspace subdomain — IN PROGRESS (Phase 4b).**
  Design confirmed with the user (registered-key human auth + ownership authz at connect
  time; wildcard-DNS routing). **Slices 1+2 landed** on `feat/ssh-key-registration`:
  foundation (core helpers + contracts + `sshKey` entity + `SshKeyService`), `/api/ssh-keys`
  CRUD, the gateway `ssh-authorize` decision endpoint, api-client, Settings page, and the
  per-workspace `ssh` command — unit + route integ green; web typecheck/lint/build green.
  **Slices 1–2c DONE — dual-trust SSH, docker-e2e validated** (#110 merged).
  `ssh-authorize` accepts gateway + agent tokens; gateway + golden-image sshd authorize
  the registered key via `AuthorizedKeysCommand`; `ssh-proxy.e2e.ts` rewritten
  self-contained (worker-thread stub + docker-run node/proxy) and 2/2 green.
  **Clean-break CA removal DONE** (`feat/ssh-registered-key-only`): deleted the
  `/ssh-cert` route + `lib/ssh-cert.ts`, `sshCert*` contracts + api-client, `gen-ssh-ca.sh`,
  `docker-compose.ssh.yml`, `EDD_SSH_CA_*` config + compute-provider injection, the
  Terraform `ssh_ca_public_key` var + #108 precondition, and all CA image wiring; migrated
  the cert-based e2e suites to registered keys (stub CP for the golden-image tests; real CP
  for user-journey + ssh-wake-chain). **Only Slice 3 remains — public SSH NLB + Route53
  `*.ssh`, AWS-gated by the account decision (#1).** Once AWS is unblocked, wire the single
  public SSH ingress. Full plan in `PLAN.md` §4b.
- **Catalog metadata picker + admin UX cleanup — DONE.** Mainline now carries the
  catalog metadata picker **and** the broader admin/navigation cleanup:
  `/admin/catalog`, legacy `/base-images` redirect, top-nav active state, unified
  session-creation entry point, stronger workspace naming/context, labeled catalog form,
  and responsive admin/data-view improvements. Verification for that pass is already
  complete: targeted web/control-plane integ green against real DynamoDB Local, full
  portal Playwright green 13/13, offline `@edd/web build` green. No additional
  implementation work is queued on that slice beyond normal post-merge follow-up if
  review turns up something concrete.
- **Dependency freshness follow-up — DONE.** The PR-era `check-deps` failure was just
  release drift under the repo's own age gate: `vitest` moved `4.1.8 → 4.1.9` and
  `@playwright/test` moved `1.60.0 → 1.61.0`. The manifests + `pnpm-lock.yaml` were
  refreshed, `pnpm check-deps` is green again, and the newer Playwright/browser stack
  re-ran the full portal suite cleanly (`13/13`).
- **Live portal e2e selector follow-up — DONE.** The container-mode live Playwright spec
  was still trying to use the removed `/workspaces` inline creator (`select.select` +
  `+ new workspace`). It now uses the current `/sessions/new` catalog picker flow, so
  the live ECS lifecycle test matches the merged UX instead of timing out on a missing
  control.
- **Golden-image collection — DONE (all PRs merged).** Split the single workspace
  image into a shared **`base`** (OpenVSCode, sshd + registered-key authorizer, idle-agent, entrypoint,
  git-credential helper, workspace user, Node, the workspace-UX fixes #90/#91/#94,
  the AI agents #93, and cross-cutting JS/TS tooling) plus thin variants `FROM base`:
  **omnibus** (all toolchains), **typescript**, **python**, **go**, **java**,
  **rust**. Just more catalog entries (the base-image allow-list) — no data-model
  change; `dev-bootstrap` seeds them; the picker already lets users choose. Sequence
  (**all merged**): **PR A** = #90/#91/#94 (#97); **PR B** = base/omnibus split (#101);
  **PR C** = slim variants + `dev-bootstrap` collection + `image-variants.e2e.ts` +
  path-gated `golden-images` CI (#102); **PR D** = #93 agents (Claude Code + Codex +
  `claude` CLI) baked into `base` + curated #95 tooling per image, extensions installed
  into OpenVSCode's **built-in** dir (no first-boot copy → no startup race) (#103).
  **Done (#104, #95 follow-ons):** rounded out the curated dev tooling — Trivy security
  scanner in base (cross-cutting, matches CI); Go staticcheck/deadcode/dupl (go+omnibus);
  cargo-audit (rust+omnibus). **Follow-ups done (#105):** (a) **Java formatter** —
  `google-java-format` added to java+omnibus (every variant now has a format CLI);
  (b) **agents omnibus-only** — moved Claude Code + Codex + the `claude` CLI out of base
  into omnibus, slimming every variant ~1 GB (slim-variant users install agents at runtime
  via #90/#91). **The golden-image collection is complete** (#97/#101/#102/#103/#104/#105).
- **Launch-readiness / observability — essentially complete** (`BUGS.md` →
  Resolved): readiness probe, storage health, structured logging, metrics + alarms,
  CloudTrail pagination, API request latency/error metrics + access logging, fleet +
  cost gauges, reconciler health (heartbeat), and a per-workspace log view. The one
  substantial item left is **`e2e-aws`** (blocked on the AWS account decision below) —
  it's where the EMF→CloudWatch metrics, alarms, and live registered-key SSH get their
  first real check. Only _Low_ follow-ups otherwise; see
  [`docs/observability-gaps.md`](./docs/observability-gaps.md).
- **Docs** — `README` doc index, [`docs/running-locally.md`](./docs/running-locally.md)
  (runnable tier commands), and the AWS [`docs/deploying.md`](./docs/deploying.md)
  runbook are current and cross-linked. **SSH CA fully removed** (2026-06-17 clean
  break): no `EDD_SSH_CA_KEY` secret, no `ssh_ca_public_key` Terraform var, no #108
  precondition. SSH is registered-key only — the gateway/workspace authorize keys via
  `ssh-authorize` using `EDD_GATEWAY_SECRET`/`EDD_AGENT_SECRET` (already provisioned);
  nothing SSH-specific is left to provision.

- **ECS compute hardening follow-ups** (from the 2026-06-13 gap audit) — mostly
  **done** (see `BUGS.md` → Resolved): `runTask` readiness gating; `EDD_AGENT_TOKEN`
  → Secrets Manager (no plaintext); real `EcsComputeProvider.health()`; ECS Exec on
  the launch path. `CONNECTION_TOKEN` injection — **DONE (2026-06-20)**: `@edd/compute-ecs` injects each
  workspace task's OpenVSCode connection token = `HMAC(EDD_CONNECTION_SECRET, workspaceId)` via Secrets
  Manager (`edd/workspace/<id>/connection`), and the in-app proxy hands the already-session-authorized
  browser the token on the initial document navigation (`editorTokenRedirect` → 302 `…?tkn=<token>`); the
  HMAC derivation is centralized in `@edd/core` (`deriveWorkspaceToken`/`verifyWorkspaceToken`). Tasks are
  also isolated to a dedicated `workspaces` security group (editor port + sshd reachable only from the
  control plane). Sim coverage: `live-ide-flow.e2e.ts` proves the injected token is the one the real editor
  runs with (workbench serves only with it) via the IDE bridge, and `agent-secret.e2e.ts` proves the
  Secrets-Manager injection; the host-process-proxy → in-VPC ENI hop is the e2e-aws tier (the sim task netns
  is not host-routable).
- **Cost — done.** Figure-exact rollups (O(recent) report) + live AWS Price List
  rate sourcing (`EDD_AWS_PRICING=1`, region-accurate, config fallback); both in
  `BUGS.md` → Resolved. The live-rate fetch is real-AWS-validated (`e2e-aws`); CI
  uses the fallback (the sim has no Pricing API).
- **Cost visualization — built** (`feat/cost-visualization`): admin `/admin/costs`
  prices the lifecycle audit ledger (compute + live-volume + snapshot) per session
  / user / fleet; lifecycle audit centralized in `WorkspaceService` so the ledger
  is complete. **Time-windowing — DONE** (`feat/cost-time-windowing`): `?window=all|1d|7d|30d`
  scopes the report to the last N days (pure interval-clipping in `@edd/core`; lifetime
  path unchanged, so the rollup figure-equivalence invariant is untouched). The earlier
  "sizable bucketed-rollup subsystem" was unnecessary — on-the-fly clipping is exact.
  The O(history)→O(recent) cost **rollups** were already done (`BUGS.md` → Resolved).
  **Graphical spend visualization — DONE (2026-06-22):** the page was tiles + text rows; it now
  also renders a no-dependency stacked proportional spend bar (compute/volume/snapshot) per
  user/session row (server-computed widths, pure div+CSS in the house style). A cost _trend_
  line would need per-day bucketing added to `computeFleetCost` first — out of scope, not queued.
- **GitHub App provider — built** (`feat/github-app-provider`): `GitProvider` seam
  (user-OAuth + GitHub-App installation-token impls), selectable by config; the
  repos/namespaces routes + clone/push broker go through it. New HARD RULE §6.9
  "Coordinates, not targets" (`AGENTS.md`): the App e2e targets the sim or real
  GitHub by coordinates alone. To run against real GitHub: register a GitHub App,
  install it on a test org with a repo, and set `EDD_GITHUB_APP_ID` /
  `EDD_GITHUB_APP_KEY` / `EDD_GITHUB_TEST_ORG` / `EDD_GITHUB_TEST_REPO` /
  `AUTH_GITHUB_API_URL`.
- **Remaining product tracks:** the browser→editor proxy is **done and simplified** — the
  external Pomerium + standalone `workspace-gate` deployment wiring (#77) was **removed 2026-06-20**
  in favor of the in-app path-based proxy (`/w/<id>/`, Auth.js session authz in-process); the
  DYNAMIC full-ECS-wake variant remains a future extension. Sim-probe/coverage pass is
  largely landed — CloudTrail for our EBS/ECS ops (#74) and the multi-generation EBS
  snapshot chain (sim handles it, none filed). ECS Exec now has a real data-channel
  proof: standard `OpenDataChannel` handshake → command output streamed from the task;
  no divergence was found.
- **Focused sockerless fidelity exploratory pass — first slice DONE (2026-06-17).**
  Adversarial conformance sweep of the AWS call shapes we depend on (process-mode sim,
  pin `c69cd278`), diffing each against documented AWS behaviour. **EBS/ECS/Secrets-Manager/
  CloudWatch error+filter shapes are largely conformant**; filed three genuine cloud-spec
  gaps upstream — **#590** (EC2 `DescribeSnapshots` ignores `MaxResults`/`NextToken`),
  **#591** (EC2 `CreateVolume` accepts a missing required `AvailabilityZone`), **#592** (ECS
  cluster-scoped ops don't raise `ClusterNotFoundException`) — **all fixed by upstream #593 and
  confirmed downstream** (submodule re-pinned `c69cd278` → `fcb58281`; see `BUGS.md`). Two
  would-be findings were discarded as probe errors, not sim bugs.
  - **Slice 2 DONE (2026-06-19, pin `322d16ad`):** ECS `RegisterTaskDefinition`/`RunTask`/`DescribeTasks`
    request-validation, EventBridge Scheduler `CreateSchedule`, CloudWatch Logs pagination, Secrets
    Manager error shapes. Filed **#618** (ECS under-validates: Fargate task def w/o cpu+mem; `RunTask
count>10`; `DescribeTasks` empty `tasks`) and **#619** (Scheduler accepts an invalid
    `ScheduleExpression`) — both non-blocking (sim is more lenient than AWS). Pagination + error shapes
    on the probed surfaces were otherwise conformant; see `BUGS.md` → External blockers. Adopt on the
    next re-pin once fixed upstream. **S3/IAM/STS were dropped from scope** — product code imports none
    of them (only EC2/ECS/CloudWatch-Logs/CloudTrail/Secrets-Manager/Pricing/Scheduler), so probing
    them would violate §6.8 "surfaces we depend on".
  - **Remaining for a later slice:** ECR (image pulls), CloudTrail filter/lookup edge cases, and KMS
    (DR) — keep it adversarial (unexpected params, pagination, error shapes), validate every probe
    against the AWS spec first, and file genuine gaps only in `e6qu/sockerless` (§0.9).
- **Module-wide sockerless fidelity audit — DONE, all 10 gaps FIXED upstream, plus follow-up #714 fixed by #715 and probe gaps #722/#723 fixed by #725, validated through integration tier + behavioral probes + heavy container-mode e2e (2026-06-29/30).** Audited every AWS resource created by `infra/terraform/modules/ecs-dev-desktop` against sockerless `08b7ee71`; filed **#703–#712**. sockerless **#713** closed all ten with real behavioral side effects. The follow-up Budgets Terraform gap (**#714**) was fixed by **sockerless #715**. The two probe-wave gaps (**#722** revoke-not-found, **#723** metric-filter validation) were fixed by **sockerless #725**. Re-pinned the submodule to `eaf80dc`. Validated: `pnpm build`/`test` green; `pnpm test:integ` green (web 130/130, reconciler 9/9, storage-ec2 15/15, e2e integ 1/1); `terraform-sim` default apply/destroy + idempotency re-plan pass; `validate-sockerless-713.sh` **13/13 PASS**; all adversarial slices pass with strict assertions. Heavy container-mode e2e (`pnpm test:e2e:local`) passes on the Podman-backed dev workstation: **19/19 tasks**, `@edd/e2e` 46/46 tests passed, 5 skipped. Local Podman fixes: `scripts/test-e2e.sh` uses `infra/images/base/build.sh`; `build.sh` auto-detects Podman and uses `podman build`; the harness starts a local insecure registry (`localhost:15000`) and pushes reconciler/proxy/base/workspace/node images, setting `WORKSPACE_IMAGE`/`RECONCILER_IMAGE`/`PROXY_IMAGE`/`NODE_IMAGE`; `turbo.json` now passes those env vars through to tests.

- **Second adversarial spec-fidelity probe wave — DONE + STRICT (2026-06-30).** Added probe slices for **SQS DLQ redrive on `maxReceiveCount`**, **Application Auto Scaling target tracking on ECS**, **ECS service scheduler `DesiredCount` reconciliation**, **EC2 security group ingress rules**, and **CloudWatch Logs metric filters**. Wired into `terraform-sim` via `run-adversarial-slices.sh`. Hardened the existing ECR/CloudTrail/KMS slice: CloudTrail pagination now uses a time-bounded window and page cap to avoid unbounded loops from prior runs. Found and filed two genuine spec gaps upstream: **e6qu/sockerless#722** (`RevokeSecurityGroupIngress` succeeds for a non-existent rule) and **e6qu/sockerless#723** (`PutMetricFilter` accepts an invalid pattern). Both were fixed by **sockerless #725**; the submodule is re-pinned to `eaf80dc` and the probes now enforce the strict assertions. Also includes the earlier boyscout flake-hardening pass for the `terraform-sim` `ResourceAlreadyExistsException` flake and CI retries on heavy e2e tiers.

- Covered (see `docs/simulator-live-coverage.md`): the real VS Code workspace
  (OpenVSCode browser proof + polyglot toolchain compiles + OpenVSCode :3000 inside
  the sim ECS task), the in-app path-based editor proxy (vscode browser e2e under `/w/<id>/`),
  portal browser lifecycle on real ECS compute, the live user journey, Auth.js callback routes,
  the real-CP wake chain, idle-agent heartbeat, reconciler scale-to-zero, per-workspace proxy authz.

---

## Blocked

- **On AWS (#1):** Terraform module is **built and sim-apply-proven** (full stack incl.
  DNS/TLS: VPC/ECS/ECR/DynamoDB+GSIs/KMS/IAM/ALB+ACM/Route53). Blocked: real apply
  (account + remote state backend), golden image real Fargate deploy, wiring `apps/web`
  to real adapters, real DNS + single-host ACM for the app/editor domain, reconciler cron, CloudTrail/
  CloudWatch/Cost observability, Phase 7, `e2e-aws`.
  - **`e2e-aws` first slice is BUILT (2026-06-17), gated only on the role/secrets.** The
    workflow (`.github/workflows/e2e-aws.yml`) wires OIDC → role, a self-contained real-EBS
    snapshot round-trip smoke (`packages/e2e/src/aws-ebs-smoke.ts`), an `always()` tag-sweep
    teardown, and a 30-min cost cap. To run when AWS lands: set repo vars `E2E_AWS_ROLE_ARN`
    (+ optional `E2E_AWS_REGION`) and dispatch on `main` with `confirm=RUN`. **Untested until
    a real account exists** — validate the teardown on the first run. Fuller suites (Fargate
    cold-start, federation, IAM enforcement, 200+ load, wake-on-connect) follow as further jobs.
- **On DNS (#2):** real `*.devbox.<domain>` routing + ACM (the module is sim-proven;
  the real hosted zone + cert issuance is AWS/registrar-gated).
- **On sockerless CloudWatch alarm fidelity:** strict CloudWatch Alarm → SNS
  probe (`adversarial-slice-cloudwatch-alarm-sns.sh`) was blocked by
  **e6qu/sockerless#749** / **#753** / **#758**. The isolated upstream
  regression test (#748) passed, but the same sequence failed in the integrated
  `terraform-sim` environment after Terraform apply/destroy cycles.
  **sockerless #756** addressed the evaluator-state issue, **sockerless #759**
  added a dangling-alarm regression test, **sockerless #761** fixed the race
  by moving state read/dispatch/write into a single `cwAlarms.Update` callback,
  and **sockerless #764** added fan-out observability logging. Submodule
  re-pinned to `6756ecfb`. Merge PR #180 once CI verifies green.

- **On bleephub GitHub team API:** bumping the submodule regressed `GET
/user/teams` to 403 Forbidden, breaking GitHub OAuth role mapping in `e2e`
  and `e2e-https`. Filed as **e6qu/sockerless#754**; fixed by sockerless
  **#756**, but the endpoint returned an empty list and the user mapped to
  `viewer` instead of `admin`. Filed **e6qu/sockerless#763**; fixed by
  sockerless **#764** (emits `X-OAuth-Scopes` for web-flow tokens).

---

## Working notes (durable)

- **Sim = sockerless, endpoint-only (HARD RULE, §6.8).** Product code _and_
  tests/fixtures differ from real cloud by **endpoint/base-domain only**. Allowed:
  `AWS_ENDPOINT_URL`, `AUTH_GITHUB_API_URL`, Entra authority, `entraSim`/`awsSim`/
  `bleephub` base URLs. **Not allowed:** sim-specific branches, fallbacks, or
  non-standard endpoints. If the sim diverges from the real API, **file upstream and
  halt**. (A sim that _accepts_ a call can still be non-conformant — audit vs the spec.)
- **Web e2e quirks:** Playwright runs against `next start` (Turbopack dev hydration is
  unreliable headless). Workspace TS packages need listing in `next.config`
  `transpilePackages`; browser `fetch` must be `bind`-ed. Auth uses the cookie dev-auth
  shim (`edd-dev-user`/`edd-dev-role`, gated on `EDD_DEV_AUTH`).
- **check-deps churn:** "latest ≥1-day-old" gate goes stale mid-PR — `pnpm update
--latest -r` + commit; `terraform providers lock -platform=linux_amd64
-platform=darwin_arm64` for the TF lock.
- **jscpd 5.x:** PR #58 updated `jscpd` to `5.0.4`; the e2e AWS sim setup helper
  keeps the stricter duplication gate below 1%.
- **Trivy `.trivyignore.yaml` format:** key is `misconfigurations:` (not `misconfigs:`);
  ID is exact string match (e.g. `DS-0002` not `DS002`). Source: Trivy
  `pkg/result/ignore.go` `IgnoreConfig` struct.
- **CI registry rate limits:** harness bring-up steps retry/backoff (public.ecr.aws /
  Docker Hub on shared runner IPs).
- **Container-mode AWS sim netns tier:** overlapping-CIDR awsvpc e2e requires the sim
  container to include `ip`/`nft`/`nsenter`/`sysctl` and run with `pid: host`, so the
  simulator can attach veths into sibling task network namespaces.
- **sockerless #520 route-table egress:** netns ECS tasks need normal AWS egress state
  (`0.0.0.0/0` via IGW + `AssignPublicIp=ENABLED`, or NAT) before they can reach
  simulator-adjacent endpoints such as DynamoDB Local. This keeps tests endpoint-only
  while matching the sim's route-table model.
- **sockerless #525/#526/#527/#530:** fixed upstream by PRs #529/#531 and included
  in the #532 pin (`638f65a`) on the follow-up branch.
- **Live simulator coverage doc:** `docs/simulator-live-coverage.md` is the source of
  truth for what parts of the app are already live-tested against sockerless AWS/Azure
  and what can move there next without violating endpoint-only rules.
- **sockerless #524/#529/#531/#532:** pinned at `638f65a` (PR #59); ECS
  `ExecuteCommand` and managed-EBS golden SSH have live coverage in
  `packages/e2e/src/golden-workspace-ssh.e2e.ts`.
- **sockerless submodule re-pinned `1ca1f71 → c69cd27` (2026-06-16):** picks up
  **#569** (process-mode managed-EBS `RunTask` panic fix — see `BUGS.md`) plus later
  Azure/GCP/GitLab simulator cells (none touch our AWS ECS/EBS surfaces). Follow-up:
  re-enable a process-mode managed-EBS `RunTask` in the `integration` job to confirm #569.
- **Gateway machine-auth:** the SSH gateway authenticates to the control plane
  with per-workspace HMAC bearer tokens derived from `EDD_GATEWAY_SECRET`
  (`apps/web/lib/machine-auth.ts`, `wake-and-forward.sh` via `openssl dgst
-mac HMAC -macopt hexkey:`). Wake routes accept it; destructive routes are
  session-only. Same scheme as the idle-agent's `EDD_AGENT_SECRET` (different
  trust domain → different secret).
- **Real-control-plane e2e harness:** `packages/e2e/src/web-app.ts` boots the
  production `next start` build on a free port (builds `apps/web` on demand if
  `.next` is missing); `docker-host.ts` probes whether containers reach the
  host via `host.docker.internal` (+`host-gateway`) or `host.containers.internal`
  (colima-style runtimes). Used by the wake-chain e2e and the live user journey.
- **Auth.js notes:** the Entra provider re-discovers the issuer for the
  id_token `tid` without `allowInsecureRequests`, so the Entra callback-route
  leg is HTTPS-only (runs in `e2e-https`). Auth.js defaults to
  `client_secret_basic`; we configure `client_secret_post` (MSAL convention;
  also sockerless #548). `AUTH_GITHUB_URL` = GHES/bleephub web base
  (provider's standard `enterprise.baseUrl`).
- **sockerless #547/#548 → fixed by PR #549** (pinned `777ffd3`): `/authorize`
  honours `login_hint` (code bound to the resolved user; unknown hint →
  `error=login_required`) and the token endpoint accepts `client_secret_basic`.
  The Entra callback leg asserts group→admin interactively via `login_hint`.
- **Golden image SSH:** the `infra/images` collection (shared `base`) includes
  `sshd`/CA/principal wiring and is covered through the AWS container-mode simulator
  with `EcsComputeProvider` managed EBS. Real deploy remains AWS-account gated.
- **Pinned versions:** `@playwright/test` ^1.60. (Pomerium was removed 2026-06-20 — the editor
  proxy is now in-process in the Next.js app.)

## Follow-ups from the cost-accuracy + boy-scout sweep (2026-07-12)

Deferred from `fix/cost-accuracy-and-boyscout-sweep` (recorded, not ignored — each is
evidence-backed from the four audits):

- **Cost-allocation tag activation (only for shared-account/scoped mode).** The account
  cost view now defaults to whole-account (correct for the dedicated EDD account), so this
  isn't needed today. If a shared account ever runs EDD with `EDD_COST_SCOPE_ENABLED=1`, the
  operator must ACTIVATE `edd:cost-scope` as a cost-allocation tag in AWS Billing (non-retroactive)
  AND confirm tag coverage; add it to the deploy runbook. (Automating via `aws_ce_cost_allocation_tag`
  is fragile — the tag must be billing-visible first — so it's a documented step, not terraform.)
- **PERF (deferred): editor-proxy re-authorizes every sub-resource request with 2 DynamoDB
  reads + a JWE decrypt** (`authorizeWorkspace`, called per proxied HTTP request). Memoize the
  decision for a short TTL keyed by (session-cookie hash + wsId); highest per-request cost on the
  proxy path. Deferred because it touches the security-critical auth path and wants a 200-user
  load test to confirm the gain and the fail-closed-at-exp behaviour.
- **PERF (DONE — windowed cost report TTL cache):** the windowed cost report (1d/7d/30d + all) is
  now process-shared TTL-cached per window (`getCostReport(days)` in `control-plane.ts`, 10s TTL),
  so the admin Costs render, its 15s live refresh, and every workspace-monitoring read share one
  scan instead of re-pricing the ledger each call. (A tighter windowed checkpoint/`byTime` bound
  is still possible later, but the cache removes the per-refresh full rescan cost.)
- **PERF (DONE — reconciler scan dedup + caches):** the maintenance tick now takes ONE fleet scan
  (`listFleetReferences`) after the mutating sweeps and threads its keep-sets into the orphan-task,
  orphan-secret, and storage GC reapers (was three identical `scan.go` sweeps); catalog `list()` is
  TTL-cached on read paths (`getCatalogList`, 10s; the editor page stays fresh); `getCostService()`
  memoizes its rollup store; `WorkspaceLive` polls at 1s while transitional and backs off to 10s/15s
  once settled (ready/stopped/terminated/error), staying fast while a resume is in flight; live AWS
  pricing (`EDD_AWS_PRICING=1`) is TTL-cached (6h). Still open: the image-source reconcile sweep runs
  on every web replica (make single-owner via a DynamoDB lease or move to the reconciler).
- **UX (DONE — spectate + admin convergence):** SpectateViewer's read-only file/terminal panes now
  sit above the interaction shield (zIndex 42 > 40) so they scroll/select while everything else
  stays inert (security is the absent write path, not the overlay); the spectate page gained a
  visible top-level "← all workspaces" back link (§9). `LiveRefresh` added to the remaining
  server-rendered admin pages (users, quotas, logs, invitations, catalog); snapshots/images already
  poll via `usePoll`, health/infrastructure via their board components, and the traffic client editor
  fetches once (page-level refresh wouldn't re-trigger it). Still open: the Costs page's optional
  computed "unattributed platform overhead" line = CE-total − attributed-workspace-total.
- **PERF (deferred): editor-proxy re-authorizes every sub-resource request** — see the bullet above;
  still deferred (security-critical auth path, wants a 200-user load test).
- **SECURITY (low, deferred):** the per-workspace connection token is a non-rotating HMAC placed in
  the `?tkn=` URL (browser history / access logs) and reused as the container credential. Prefer
  handing it via `Set-Cookie` on the redirect (the `vscode-tkn` cookie path exists) or rotate per
  session; ensure access logs redact `tkn`. Also: a full script/style CSP on the control-plane
  surface (needs nonce plumbing through Next's hydration scripts) beyond the frame-ancestors
  header already shipped.

- **SECURITY (deferred): dev-auth production backstop.** `devAuthEnabled()` is guarded only
  by `EDD_DEV_AUTH=1` (the deployment never sets it). A code backstop can't key off
  `NODE_ENV=production` — the Playwright harness runs a prod build WITH dev-auth, so that
  breaks the test harness. Add a backstop keyed on an EXPLICIT real-prod signal the harness
  never sets (e.g. `EDD_ENV=production` set only by the deploy, or "real IdP configured"),
  then fail closed if `EDD_DEV_AUTH=1` appears alongside it.
