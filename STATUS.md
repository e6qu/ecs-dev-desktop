# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-06-19 (Phase 9 remediation merged via #129; self-recovery + monitoring opened as #130, driving the e2e VS Code flake to green)

## Current focus — Self-recovery + monitoring (PR #130, codex-advised)

Four user-requested themes built together on `feat/self-recovery-and-monitoring` (PR #130), after a
codex self-recovery review synthesised with our own analysis and four design decisions confirmed with
the user (one bundled PR; desired-state + tombstone async delete; Middle data-safety; live config
self-check now):

1. **Self-recovery / convergence.** Durable intent (`desiredState` present/deleted) + a `deleting`
   tombstone makes an interrupted delete resumable. New pure fns `markDeleting` / `markRecovered`
   (error→stopped only with a snapshot) / `markSnapshotLost` / `isUnrecoverable`. `remove()` CAS-marks
   the tombstone (DELETE → **202**); the reconciler's `finishDeletions` / `recoverErrors` /
   `detectStorageDrift` sweeps (budget-bounded, `DEFAULT_CONVERGE_BUDGET=50`) converge toward intent,
   snapshot-before-destroy in `finishDeleting`.
2. **Functional usability checks.** idle-agent `functional_body()` probes the IDE port + a writable
   HOME, folded into the heartbeat → `functional` ok/degraded surfaced in admin Inspect + a metric.
3. **Privilege/security warnings.** In-image `edd-privilege-guard.sh` shims docker/sudo/etc. → friendly
   message, structured stderr log, best-effort POST → first-class audit event + `security.privilege_attempt`
   metric; alarm `security-privilege-attempts`.
4. **Config-sync self-check.** Pure `evaluateConfigSync` → `/api/admin/config-sync`,
   `api-client.adminConfigSync`, an Infrastructure-page card, and a new thin **`@edd/cli` `edd` CLI**
   (`edd config-sync` / `doctor`) over the SDK.

**Status:** all CI jobs green except `e2e`, whose only failure is the known heavy `pw:vscode`
keystroke-landing flake (the keyboard burst dropped before xterm attached; unrelated to these changes —
the privilege-guard shims cover docker/sudo, not the Go toolchain). Re-triggered the `e2e` job.

## Prior focus — Phase 9: code-review remediation (codex 2026-06-19, merged #129)

A deep `codex` review (read-only; model `gpt-5.5`) produced 12 findings, 4 independently re-verified,
all actionable without the AWS account decision — 4 Critical (silent prod fake-provider fallback;
terraform IAM missing the agent-secret create/inject path; workspace exec/task role ARNs never passed;
SSH-key uniqueness race), 3 High (no early snapshot → fresh-workspace data loss; hidden
repo-clone/git-credential failures; un-GC'd per-workspace secrets), 4 Medium/Low. The previously-parked
cross-region EBS snapshot DR flow was pulled in (sim-validatable via sockerless#602); only genuine
real-AWS work stays under open decision #1. Merged as **#129**.

## Prior phase — user-registered SSH keys + per-workspace SSH subdomain (Phase 4b)

**In progress — user-registered SSH keys + per-workspace SSH subdomain (Phase 4b).**
The user asked for: each user inputs their SSH key, and SSHes into each running
workspace at its own subdomain. Confirmed design: SSH is **registered-key only** —
both the human→gateway hop and the internal gateway→workspace hop authenticate by
the user's **registered public key** and authorize the workspace by **ownership at
connect time** (`ssh-authorize`). There is **no SSH CA and no certificates** — the
CA path was fully removed in a clean break (we carry no legacy; mid-development).
Routing is wildcard-DNS → one public gateway (stock OpenSSH; the workspace id rides
in the subdomain/username since SSH has no SNI). **Slices 1+2 landed on `feat/ssh-key-registration`:**

- **Slice 1 (foundation):** branded ids + pure `fingerprintPublicKey` (matches
  `ssh-keygen -lf`) + `workspaceSshHost`/`isWorkspaceLabel` (`@edd/core`);
  register/list/delete contracts (`@edd/api-contracts`); the `sshKey` ElectroDB
  entity with a `byFingerprint` GSI + global key uniqueness (`@edd/db`);
  `SshKeyService` (register/dedup/list/ownership-delete/`ownerForKey`)
  (`@edd/control-plane`).
- **Slice 2 (API + portal):** `/api/ssh-keys` CRUD + the gateway connect-time
  decision endpoint `/api/workspaces/:id/ssh-authorize` (machine-auth; authorize iff
  the key is registered to the workspace owner) — the seam the gateway will call;
  api-client methods; Settings → SSH keys page; per-workspace `ssh …` command on the
  workspace card (when `EDD_SSH_BASE_DOMAIN` is set); `SSH_BASE_DOMAIN` config.

Verified: core+contracts unit green (173), service+entity + route integ green on
DynamoDB Local (ssh-keys CRUD/conflict/isolation + ssh-authorize
owner/mismatch/unregistered/no-token), web typecheck+lint+offline build green.
**Slice 2c complete — dual-trust SSH, docker-e2e validated** (chosen over a
terminating bastion; no Teleport — same public surface either way, and dual-trust
keeps VS Code Remote-SSH/scp/forwarding). Both sshds authorize the **same registered
key** via `ssh-authorize` (the gateway with its token, the workspace with its agent
token). On `feat/ssh-dual-trust`: `ssh-authorize` accepts both tokens; the **gateway**
sshd and the **golden image** both authorize via `AuthorizedKeysCommand`. The
`ssh-proxy.e2e.ts` was rewritten self-contained (worker-thread stub control plane +
docker-run node + proxy) and **validated 2/2 green**: a registered key is authorized
at both hops and lands on the node, an unregistered key is denied.

**Clean-break CA removal complete (2026-06-17, `feat/ssh-registered-key-only`).**
With dual-trust proven, the entire SSH-CA path was deleted — no additive shim, no
legacy: the `/ssh-cert` route + `lib/ssh-cert.ts`, the `sshCert*` contracts +
api-client method, `scripts/gen-ssh-ca.sh`, `docker-compose.ssh.yml`, the
`EDD_SSH_CA_*` config + compute-provider env injection, the Terraform
`ssh_ca_public_key` var **and** its #108 half-config precondition, and all CA wiring
from the golden/gateway/node images. The cert-based e2e suites were migrated to
registered keys: `golden-workspace-ssh` + `data-durability` use an in-process
`ssh-authorize` stub control plane; `user-journey` registers an account key via the
API; `ssh-wake-chain` registers a key and proves the gateway wakes a STOPPED
workspace through the **real** control plane (landing-on-node stays covered by
`ssh-proxy`). Docs + the architecture table + the `EDD_SSH_CA_KEY` deploy secret
were all updated. CI builds `edd-workspace-node:e2e`. **Only Slice 3 left —
public SSH NLB + Route53 `*.ssh` (AWS-gated, decision #1).** See `PLAN.md` §4b.

**Catalog and session-launch UX cleanup are now part of the current mainline state.**
The golden-image collection remains fully complete — the base/omnibus split + slim
variants (#97/#101/#102/#103), the fuller per-language tooling (#104), and both
post-#104 follow-ups (#105). The latest completed pass was a broader
**catalog/admin UX refactor** layered on top of the catalog metadata picker:

- base-image catalog entries carry structured **tags** + **tool highlights** end to end;
- the new-session launcher uses a card-based environment picker with that metadata;
- catalog management moved into the admin IA at **`/admin/catalog`** (the legacy
  `/base-images` route redirects there);
- `/workspaces` no longer presents a competing inline creator — session creation is
  unified around `/sessions/new`;
- workspace/admin lists now show catalog display names and stronger environment context
  instead of mostly opaque ids/image refs;
- top-level nav now has active-state location awareness, and the admin shell has better
  narrow-width behavior;
- the catalog form is labeled/grouped like an operator tool rather than placeholder-only.

Also folded into the same pass while chasing unrelated but live issues proactively:
(a) the web app no longer depends on `next/font/google`, so `pnpm --filter @edd/web build`
works offline/in-sandbox; the typography now comes from local/fallback family variables in
`globals.css`. (b) `waitForDynamo()` now fails **before** Vitest's hook timeout with an
explicit endpoint-bearing error (`DynamoDB at http://127.0.0.1:8000 did not become ready
within 10000ms`) instead of opaque 30s hook timeouts when DynamoDB Local is absent.

Verification for this state included real local DynamoDB-backed runs (outside the
sandbox where loopback access was permitted): `@edd/web` targeted integ green,
control-plane catalog integ green, and the full portal Playwright suite green
**13/13**. Local static verification also stayed clean:
`@edd/{api-contracts,db,core,control-plane}` builds green;
`@edd/{db,core,control-plane,web}` lint green; `@edd/web build` green.

After that pass, the dependency-freshness gate moved again: `check-deps` flagged
`vitest` and `@playwright/test` as behind the latest age-eligible versions. Both
were refreshed (`vitest 4.1.8 → 4.1.9`, `@playwright/test 1.60.0 → 1.61.0`), the
pnpm lockfile was updated, `pnpm check-deps` returned clean again, and local
verification re-confirmed a representative Vitest target plus the full portal
Playwright suite green **13/13** on the newer browser stack.

One more CI follow-up surfaced after that: the **live** portal Playwright spec
still automated the removed `/workspaces` inline `<select>` creator. The live test
now drives the current `/sessions/new` launcher instead (catalog picker card +
`blank session`), matching the merged UX. Local verification for the fix covered
type-checking plus the standard portal Playwright suite green **13/13**; the full
container-mode live harness remained a CI-only repro in this shell.

A `BUGS.md` follow-up was then resolved: confirm sockerless#569 (managed-EBS
`RunTask` panicked the process-mode sim) downstream. Confirmed fixed — against the
re-pinned sim (`c69cd278`) the managed-EBS `RunTask` now returns a task ARN and the
sim stays healthy through the async EBS transition where it previously crashed. The
note's "re-enable a process-mode managed-EBS `RunTask` in the lightweight
`integration` job" was itself misframed: the `integration` tier is the API-surface
process-mode sim with **no container runtime** (CLAUDE.md §5), so a workspace
`RunTask` cannot reach RUNNING there and asserting otherwise would be a
target-specific assertion (§6.9). That path is — correctly — covered in the
container-mode `e2e` tier (`agent-secret.e2e.ts`, workspace-lifecycle, user-journey).
`BUGS.md` was updated to mark #569 confirmed and close the follow-up; no code change.

(A second stale note about `EDD_SSH_CA_KEY` Terraform provisioning, and the #108
half-config `precondition` added to guard it, are now moot — the entire SSH-CA
path was removed in the 2026-06-17 clean break above. There is no CA secret, no
`ssh_ca_public_key` var, and no precondition to provision or guard.)

## Prior phase (merged, #105)

**Golden-image follow-ups: Java formatter + agents omnibus-only.** (a) **Java
formatter** — added `google-java-format` (the de-facto Java formatter; JAR +
`/usr/local/bin` wrapper) to **java**+**omnibus**, so every language variant now has a
format CLI; version resolved via the github.com `releases/latest` redirect (not the
rate-limited api.github.com). (b) **Agents omnibus-only** — moved the AI agents (Claude
Code + Codex extensions + the `claude` CLI, ~1 GB native) OUT of **base** into
**omnibus only**, so the slim variants drop ~1 GB each (base ~1.8→~0.9 GB; typescript
~2.2→~1.3, python ~3.6→~2.7, go ~1.4, java ~1.7, rust ~1.8); a slim-variant user
installs the agents at runtime via the user-CLI path (#90/#91). Tests: `image-variants.
e2e.ts` asserts agents ABSENT in slim variants + java has google-java-format;
`workspace-toolchain.e2e.ts` keeps the omnibus agent assertions (now genuinely
omnibus-sourced) + adds google-java-format. (Local verification was hampered by a
podman tag-reversion/GC quirk; CI built fresh and went green 5/5 + omnibus.)

## Prior phase (merged, #104)

**Golden-image fuller per-language dev tooling (#95 follow-ons).** Rounded out the
curated dev-tooling set so a workspace matches CI out of the box. Added the
cross-cutting **Trivy** security scanner to **base** (the repo CI's own gate tool —
every variant inherits it; single binary to `/usr/local/bin`, vuln DB fetched lazily);
the **Go** dead-code/CPD/static set to **go**+**omnibus** (`staticcheck`, `deadcode`,
`dupl` alongside golangci-lint, all `go install` → `GOBIN=/usr/local/bin`); and
**cargo-audit** (Rust SCA/security) to **rust**+**omnibus**. Tests extended:
`image-variants.e2e.ts` (go asserts the trio, rust asserts cargo-audit, every variant
asserts trivy) + `workspace-toolchain.e2e.ts` (omnibus asserts all). Also **re-pinned
the sockerless submodule** `1ca1f71 → c69cd27` (picks up #569's process-mode managed-EBS
panic fix + later cells). Known remaining gap: **Java** has the JDK/Maven/Gradle +
`redhat.java` extension but no standalone formatter/linter CLI — flagged.

## Prior phase (merged, #103)

**Golden-image collection — AI agents + curated dev tooling (PR D; #93 + #95).**
Completed the collection. **base** now bakes
the **AI coding agents** (Claude Code + Codex extensions + the `claude` CLI) and the
cross-cutting JS/TS tooling that matches our CI (prettier/eslint/knip/jscpd + their
extensions). Each **variant** adds its language tooling + extensions: python
(ruff/ty/vulture/bandit/semgrep + Python/Ruff/ty/basedpyright/Semgrep exts), go
(golangci-lint + golang.go), java (redhat.java), rust (clippy/rustfmt +
rust-analyzer); **omnibus** carries them all. Key mechanism: extensions can't be
baked into the EBS-shadowed home extensions dir, so they're installed into
OpenVSCode's **built-in** extensions dir (`/opt/openvscode-server/extensions`) at
build — loaded read-only with **no runtime copy** (a ~1 GB first-boot copy slowed
task startup and caused live-sim timing races) and surviving the mount; users still
install their own into the volume dir. Dev-tool CLIs go to system paths
(`uv` → `/usr/local/bin`, `go install` → `GOBIN=/usr/local/bin`) to survive the
mount; the IDE bridge retries token extraction (a task is ECS-RUNNING before
OpenVSCode execs). OpenVSCode Server defaults to **Open VSX**, so `--install-extension`
works with no gallery config. Verified: all 7 images build; `image-variants.e2e.ts`
5/5 + `workspace-toolchain.e2e.ts` 12/12 + `live-ide-flow`/`user-journey` re-green.
Size note: the
baked agents (~1 GB native) live in base → every variant carries them (typescript ~2
GB … omnibus ~5.7 GB); flagged for a possible opt-in later. **Golden-image collection
plan complete** (PRs A–D).

## Prior phase (merged, #102)

**Golden-image collection — slim per-language variants.** Five lean variants `FROM
base` (typescript/python/go/java/rust), `dev-bootstrap` seeds the collection, the
`image-variants.e2e.ts` smoke test, and a path-gated `golden-images` CI workflow.

## Prior phase (merged, #101)

**Golden-image collection — base/omnibus split.** Refactored the single image into a
shared `infra/images/base` (runtime + the #90/#91/#94 fixes, no toolchains) + `omnibus`
(`FROM base` + full toolchain, == the previous image, tagged `edd-workspace:e2e`).
Composable PATH drop-ins; build-time system `npm i -g` forced to `/usr/local` (the
home `NPM_CONFIG_PREFIX` is inherited). Verified via toolchain + live-IDE-flow e2e.

## Prior phase (merged, #97)

**Golden-image workspace UX fixes (#90/#91/#94).** A fresh workspace is usable from
the in-browser terminal: non-root `npm install -g` works (npm prefix → HOME dir),
user CLIs on PATH across the shell matrix (image ENV + profile.d + sshd `SetEnv`),
and the editor defaults to Dark mode (entrypoint first-boot seed). These now live
in the shared `base` (PR B). Key nuance: anything under `$HOME` baked at build is
shadowed by the EBS volume mount → seed at first boot or use a system path.

## Prior phase (merged, #89)

**End-to-end live IDE flow, tested in CI on Linux and macOS.** On
`feat/live-ide-flow-ci`: brought the whole stack up against the container-mode sim
with a real ECS cluster and proved "create a workspace and open its IDE" — the
control plane launches a workspace as a real ECS task (managed EBS + awsvpc ENI;
container mode is unaffected by sockerless#569), and the **actual OpenVSCode
workbench** opens through a new IDE bridge (`packages/e2e/src/ide-bridge.ts`): the
sim isolates each task's awsvpc netns (not attached to any host-reachable Docker
network), so the bridge tunnels host → `docker exec` → the task netns → `:3000` and
extracts the per-boot connection-token. It is the local/sim realisation of the
production identity-aware-proxy reach (the CONNECTION_TOKEN handoff stays the future
product extension). New `live-ide-flow.e2e.ts` asserts create → 403 token gate →
200 workbench; `live-sim-run.ts` is a one-command interactive harness that
auto-creates a workspace, bridges it, and prints the web and IDE URLs. CI: the e2e
runs every PR in the Linux `e2e` job; a gated `e2e-flow-macos` job
(`macos-15-intel` + colima — Intel is required, Apple-silicon runners can't boot
colima's VM; `workflow_dispatch` or the `ci:macos` PR label, to bound expensive
macOS minutes) runs the identical flow on macOS. Both container images (the 3 GB
golden workspace + the from-source AWS sim) are built once natively on Linux and
pushed to GHCR (a `macos-images` job); the macOS job pulls and runs them with
`--no-build` — building under colima is far too slow (the sim build alone took
~55 min) and the golden image needs BuildKit the legacy builder lacks. The GHCR
packages are **ephemeral CI fixtures, not releases**: named `edd-ci-*`, tagged
run-scoped (`ci-<run_id>`, rebuilt from PR code every run, never reused/stale),
and labelled "NOT a release". (There is no release pipeline in the repo.) Verified locally (3 green runs; task
container observed live). Known quirk: sim task containers are reaped after a few
idle minutes — irrelevant to the fast e2e, flagged for the focused sim-fidelity pass.

## Prior phase (merged, #88)

**Admin Infrastructure view + provisioning failure as a handled 503.** (1) A
compute-launch failure is now a **handled** condition: `create()` throws a typed
`ComputeUnavailableError` (route → 503) and `start()` returns the new `unavailable`
domain error (→ 503); `withObservability` observes-and-re-raises (only genuinely
unexpected errors are 500); the api-client tolerates an empty/non-JSON error body;
`dev-bootstrap` seeds the full golden catalog. (2) New `/admin/infrastructure`
aggregate — dependency status checks, the live ECS cluster (`clusterInfo()` via
DescribeClusters; the fake reports its in-memory equivalent), fleet metrics, and
the **component topology** (`SYSTEM_TOPOLOGY` pure graph in `@edd/core` with live
health overlaid; boundary/dynamic nodes `unknown`, never a fabricated `ok`). New
`InfrastructureService` shell, contracts + api-client method, route/page/nav, and
Playwright coverage; live-view polling shared into a `usePoll` hook + `HealthRows`/
`HealthHead`.

## Prior phase (merged, #87)

**Docs accuracy pass — run-everywhere story.** Reviewed all docs against current
code and fixed drift: the README now frames the run spectrum (local fakes → local
sims → cloud via the Terraform module) and uses `edd.localhost`;
`docs/running-locally.md` gained the missing `+ Entra` command (with the HTTPS
caveat); `docs/deploying.md` split env into `secret_environment` vs
`extra_environment`, fixed the FARGATE/`golden_repository_urls` nits, and the SSH CA
material default; the module README inputs/outputs tables gained the alarm vars + 5
missing outputs; and the `examples/complete` composition now wires
`extra_environment` (so `EDD_ADMIN_GROUPS` is settable) with a fuller tfvars
example. `terraform fmt`/`validate` clean.

## Prior phase (merged, #86)

**Local dev login UI (seeded users) + `edd.localhost` cookie isolation.** Replaced
the hand-edit-cookies dev-auth flow with a real `/login` form (gated on
`EDD_DEV_AUTH=1`): pick a seeded account + password. The accounts are
**configuration, not app code** — `@edd/config` `devUsers()` parses `EDD_DEV_USERS`
(JSON) with a built-in default set (admin/member/viewer), and `devPassword()`
(`EDD_DEV_PASSWORD`, default `dev`); a per-account `password` overrides it. Server
actions set host-only `edd-dev-*` cookies (scoped to `edd.localhost`, so other
localhost apps' cookies aren't disturbed) and a dev-aware sign-out clears them.
Playwright tests (`e2e/login.pw.ts`) sign in via the form as each role and assert
role-appropriate access (admin reaches the console; member/viewer denied;
wrong-password rejected; sign-out clears). Also: `pnpm reap` now actually tears
down profile-scoped sim containers (it was skipping `--profile` services), and a
reusable `pnpm --filter @edd/web screenshot` captures the dev UI. Verified live
against the sockerless tier (`pnpm dev` + `EDD_DEV_PROFILES=aws`).

Also folded into this PR (CI surfaced the recurring flake): **wake-on-connect
claim-before-launch** — the wake path persists the `stopped → provisioning` claim
(version CAS) before launching, so a burst of concurrent connects starts exactly
one task and the rest wait for it, instead of N launched-then-compensated tasks (a
thundering herd that intermittently overran the sim). Two-phase domain
(`markWaking`/`markProvisioned`), a `provisioning → stopped` rollback transition,
strict `start()` + idempotent `connect()` re-dispatch. Proven deterministically in
the integ tier (N concurrent wakes → one launch, all running).

## Earlier (merged, #85)

**Observability completion — the remaining launch-readiness gaps, in one PR.**
Building on the #84 audit, closed everything actionable left in
`docs/observability-gaps.md`: (1) a `withObservability` route wrapper emits
per-request latency/status/error metrics + a structured access log across all
business API routes; (2) the reconciler emits fleet gauges (total/running/stopped/
active) + a priced `fleet.cost.usd` each sweep; (3) reconciler health is real — a
heartbeat record + `reconcilerHealthFromHeartbeat` staleness check replace the
hardcoded `unknown` on the board; (4) the admin Logs view filters the container
stream to one workspace (`?workspaceId=` → task log-stream prefix); (5) SSH-cert
issuance accepts the CA private key as material via `EDD_SSH_CA_KEY` (Secrets
Manager ARN — the secure default, never in Terraform state). All coordinate-driven
and unit/integ-tested. The one substantial item left is **`e2e-aws`**, external —
blocked on the AWS account decision (open decision #1).

## Earlier (merged, #84)

**Docs review + launch-readiness audit.** Reviewed all docs and made them
navigable and accurate: surfaced previously-orphaned docs (`admin-ui-design`,
`infra/images`, `infra/proxy`, `services/ssh-gateway` READMEs) in the README index;
added a full AWS deployment runbook (`docs/deploying.md`); made the
`docs/running-locally.md` tier commands runnable; inventoried the
logs/health/status/metrics/testing gaps in `docs/observability-gaps.md` and closed
the headline ones — `/api/readyz` readiness probe, storage Health-board check,
structured logging, a metrics layer (`@edd/cloudwatch-metrics` EMF) with CloudWatch
alarms, and CloudTrail audit pagination.

## Earlier (merged, #83)

**On `feat/ecs-exec-datachannel-proof`:** the container-mode ECS Exec coverage now
proves the command path, not just the `ExecuteCommand` response shape — opens the
returned SSM WebSocket, sends the standard `OpenDataChannel` handshake, runs a
marker command, and asserts it in the streamed AgentMessage frames. Also hardened
the control-plane AWS clients (ECS/Secrets/EC2) to adaptive retry (`maxAttempts=6`)
so concurrent wake-on-connect bursts don't surface a transient `RunTask` 5xx.

## Earlier (merged, #82)

**On `feat/aws-price-list`:** accurate costing now sources rates from the **AWS
pricing model directly** — live from the AWS Price List API (`pricing:GetProducts`)
for the deployment's region (`apps/web/lib/aws-pricing.ts`), opt-in via
`EDD_AWS_PRICING=1`, best-effort with per-rate fallback to the configured
`@edd/config` rate (so a missing/denied API never mis-prices). The pure parser is
unit-tested against a recorded GetProducts shape; the live fetch has no simulator
(no Pricing API) so it's exercised against real AWS (`e2e-aws`), CI uses the
fallback. Formula unchanged (Fargate vCPU/GB-hr + EBS/snapshot GB-mo).

## Earlier (merged, #81)

**On `feat/cost-rollups`:** the cost report moves from O(history) to O(recent)
without changing the figures. New pure core (`deriveBillingState`/`resumeBilling`,
46 figure-equivalence cases) lets the report price each workspace by resuming a
persisted checkpoint + replaying only the events since it; a `costRollup` DynamoDB
entity (reuses GSI1, no table change) + `StoredCostRollupStore` + `CostService.rollup()`
(admin trigger `POST /api/admin/costs/rollup`) persist/regenerate the checkpoints;
`report()` uses them when present, else the exact full scan. Proven byte-identical
to the full scan against DynamoDB Local (`cost-rollup-equivalence.integ.ts`).
Pricing uses the AWS on-demand **model** (Fargate vCPU/GB-hr + EBS/snapshot GB-mo,
us-east-1 rates, `EDD_PRICE_*`-overridable); live region-accurate rate sourcing via
the AWS Price List API is the next (real-AWS-validated) follow-up — `BUGS.md` → Open.

## Earlier (merged, #80)

**On `feat/ecs-secrets-health-cost-exec`:** an ECS hardening sweep clearing the
remaining Open compute items:

- **Agent token → Secrets Manager (security).** `runTask` stores the per-workspace
  HMAC agent token in a Secrets Manager secret and references it from a
  per-workspace task def's container `secrets`, instead of plaintext
  `environment` (which surfaced in DescribeTasks/CloudTrail). ECS resolves it into
  the container env at launch. Container-mode e2e (`agent-secret.e2e.ts`) +
  user-journey heartbeat prove it.
- **Real `health()`.** DescribeClusters-backed compute health (ACTIVE→ok), closing
  the inverted contract (board showed `unknown` on AWS). Process-mode integ.
- **ECS Exec on the launch path.** `runTask` sets `enableExecuteCommand: true`.
- Found + filed a sim bug (**sockerless#569**): process-mode RunTask with managed
  EBS panics (nil Docker client), so the secret/runTask path is validated in
  container mode (not the process-mode `integration` job).

Done since: **cost-report time-windowing** — `/admin/costs?window=all|1d|7d|30d`
scopes the report to the last N days (pure interval-clipping in `@edd/core`; the
lifetime path is byte-identical, so the rollup figure-equivalence invariant is
untouched). The feared "sizable bucketed-rollup subsystem" was unnecessary —
clipping the lifetime intervals to the window is exact. Still deferred:
`CONNECTION_TOKEN` injection (lands with the future DYNAMIC wake-on-connect gate
it's tied to).

## Earlier (merged)

**`runTask` readiness gating (#79):** `runTask` waits for the task to be READY
(`taskReady`: RUNNING + managed-EBS volume + ENI) before returning, so the control
plane never advertises a workspace that can't yet accept connections.

**On `feat/sim-probe-coverage`:** a sim-probe coverage pass — added a
**multi-generation EBS snapshot-chain** probe to `packages/storage-ec2/src/ec2-storage.integ.ts`:
snapshot a volume that was itself hydrated from the previous generation's snapshot,
twice, asserting per-generation snapshot→source lineage and restore-from-a-restored-
snapshot. This is the scale-to-zero persistence loop over repeated idle cycles at the
EC2-API layer. The sim handles it correctly (probe green) → no upstream gap to file.
The §6.9 storage filter comment is current (the stale workaround was removed in #74).

**Prior phase (merged, #77):** the **live per-workspace-authz chain** (increment-2 /
DO_NEXT #5) — the PEP→PDP decision proven in the real Pomerium routing path.

The #77 chain also found+fixed a real PDP bug (the proxy preserves a non-default
`Host` port while Pomerium binds the assertion `aud`/`iss` to the bare hostname → the
PDP now authorizes on the port-stripped hostname) and a gate `Dockerfile` missing
`@edd/core`; it standardized the local app port 3000 → **3700**.

**Earlier (merged):** a **GitHub App** provider behind a new
`GitProvider` seam, plus a new architectural principle. `apps/web/lib/github.ts`'s
token-parametrized functions become `UserOAuthGitProvider` (default), joined by an
`InstallationGitProvider` that signs an RS256 app JWT (`jose`) → mints an
installation token (`ghs_…`) → installation-scoped REST. `getGitProvider(ownerId)`
selects by config (`EDD_GITHUB_APP_ID` + `EDD_GITHUB_APP_KEY` → App mode, else the
user's stored OAuth token); the repos/namespaces routes + the clone/push broker go
through it (the broker picks the installation by the repo's owner). The git
credential is wire-identical (`x-access-token` + bearer), so the broker + UI are
provider-agnostic. **New HARD RULE §6.9 "Coordinates, not targets — the simulators
do not exist":** to the app + tests there is no sim-vs-real branch anywhere; only
**coordinates** (endpoints, credentials, resource ids) point at a target, and the
same code/test hits a sockerless sim or the real cloud by changing coordinates
alone, through standard APIs only (never a sim's `/internal`). The App e2e
(`github-app.e2e.ts`) is **purely coordinate-driven**: it reads the App's id + key +
org/repo + base URL from env and **skips** when absent — it has no notion of
bleephub. bleephub can't yet seed a pre-registered App via standard config, so CI
can't supply sim App coordinates; filed upstream as **sockerless#559** (the e2e runs
against real GitHub when secrets are supplied; the provider + app-JWT logic is
unit-tested meanwhile — 12 tests). Gates green (lint/knip/jscpd/build/unit).

**Prior phase (merged):** the **cost visualization** track (PR #71) —
the last of "admins + costs + audit" (admins ✓, audit ✓ #70). An admin **Costs**
console (`/admin/costs` + `/api/admin/costs`) prices each workspace's running vs.
scaled-to-zero time and rolls it up per session, per user, and to a fleet total
(compute = Fargate vCPU+memory while running; storage = live EBS while running;
snapshot = EBS snapshot while scaled-to-zero). Run-time is **derived from the
lifecycle audit ledger** (user decision), and pricing defaults to **us-east-1
on-demand, env-overridable** (`@edd/config`). Making the ledger authoritative
required **centralizing lifecycle audit in `WorkspaceService`**: it now records
`session.create/start/stop/delete` on the _actual_ state transition — so
gate-wakes (`connect()`) and reconciler scale-to-zero/drift stops are captured
exactly once (route-level emits removed; actor threaded, `system` for
machine/reconciler). **Accuracy is not an MVP compromise:** each event is written
in the SAME DynamoDB transaction as its transition (`createWriteTransaction`), so
the ledger can never drop or double-count a billable event — proven by
`cost-ledger-atomicity.integ.ts`; deleted workspaces still price (events are
append-only). **Live:** a running workspace's open interval is priced to `now` on
every fetch, and the page auto-refreshes (`LiveRefresh`, 15 s) so consumption is
visible in near real time. The pure cost model is in `@edd/core`
(`deriveBillingIntervals`/`priceIntervals`/`computeFleetCost`); `CostService`
joins the ledger with current records. Gates green (lint/knip/jscpd/unit/integ/
web build/Playwright 9/9).

**Prior (merged to `main`):** PR #68 (per-workspace proxy authz — gate PEP +
PDP), PR #69 (core user loop — repo-per-session + private clone/push broker +
wake-on-connect gate + GitHub launcher UI; polyglot golden image + real-VS-Code
proof + ECS hardening), PR #70 (first-class audit log). The core-user-loop detail
below describes the now-merged #69 work:

- **Repo-per-session** (incr. 1): `repoUrl` threaded end-to-end; golden image
  clones the repo on first boot (idempotent; skips on snapshot wake). Public
  clone proven against the real image. `repoUrl` optional (blank sessions OK).
- **Private clone + push** (incr. 1b): AES-256-GCM `token-crypto`, per-owner
  `gitCredential` entity + `GitCredentialService`; GitHub token captured at
  sign-in (encrypted, server-side); **agent-only broker**
  `GET /api/workspaces/:id/git-credential` + an in-image git credential helper
  fetch the token at use time — clone+push work with **nothing on the EBS
  volume**. Token never in task metadata or the browser.
- **Wake-on-connect gate** (incr. 2 core): the workspace gate resolves each
  workspace's live address per request (ws-id from Host → `POST /connect` wake →
  `GET /connect-info?protocol=http` via gateway HMAC) and proxies HTTP+WS — one
  gate fronts every workspace (Pomerium's single static upstream), waking
  scaled-to-zero sessions on reconnect (the "reopen → session intact" behavior;
  session state persists on the EBS snapshot). OpenVSCode
  `--without-connection-token` flag for the gated deployment.
- **GitHub session launcher** (incr. 3): `GitProvider` (list repos, namespaces
  with permission flags, create repo) + `/api/github/repos|namespaces` routes
  (token server-side only) + the **`/sessions/new` UI** — search repos → start
  session, or create a repo (default private; **grayed out with the reason** when
  not permitted), or blank session.

Decisions honored: clone via the user's GitHub OAuth token (encrypted, brokered);
gate-is-the-auth (tokenless OpenVSCode behind it); many sessions per repo per
user; cross-user isolation via proxy authz. Remaining: increment-2 deployment
wiring (Pomerium→gate route + full browser e2e) and the first-class audit log +
cost-visualization tracks. SAST hardening this round: pinned GCM auth tag length;
test secrets generated at runtime.

## Prior phase

**PRs #56–#67 are merged to `main`** (test-gap closure, gateway machine-auth,
sockerless #549/#550 consumption, live portal + Pomerium browser e2e over TLS,
the lifecycle correctness-hardening pass, the authz/concurrency depth pass —
delete-vs-wake leak fix, exhaustive CASL matrices, snapshot-vs-stop conflict fix
— and data durability across a real scale-to-zero cycle + the reconciler
container drift sweep).

**PR #68 is merged** (per-workspace proxy authorization — the gate PEP +
`/api/internal/authz` PDP, ownership by owner email).

Current branch `feat/vscode-workspace-proof` proves the headline product — a
usable VS Code workspace — and hardens the ECS service:

- **Polyglot golden image, out of the box.** `infra/images/workspace` now ships
  Node 22 (npm/yarn/pnpm/bun), C/C++ (build-essential), Go, Java + Maven +
  Gradle, Rust, Python + uv, and Playwright + headless Chromium. Tools install
  system-wide with a `/etc/profile.d` entry so they're on PATH for the OpenVSCode
  terminal and SSH. ~3 GB image (headless-shell, not full Chromium, to stay
  lean). `packages/e2e/src/workspace-toolchain.e2e.ts` compiles+runs a
  hello-world in every language (real artifacts) as the `workspace` user.
- **Real VS Code, driven in a browser.** `apps/web/e2e/vscode-workspace.pwvscode.ts`
  (`test:pw:vscode`) loads the OpenVSCode workbench, opens the integrated
  terminal, types code, compiles it, and verifies the produced ELF binary on
  disk — with screenshots. The headline promise, proven end to end.
- **OpenVSCode :3000 inside the sim ECS task.** `golden-workspace-ssh.e2e.ts`
  now also asserts the awsvpc task serves OpenVSCode on :3000 (its token gate),
  not just sshd.
- **ECS compute hardening** (gap audit): task def declares `portMappings`
  (3000 + 22); `executionRoleArn`/`taskRoleArn` supported; `fromEnv` reads task
  sizing + roles (were hardcoded in production); `awslogs-region` via config;
  `stopTask` sends a reason. Remaining follow-ups in `BUGS.md` → Open (readiness
  gating, ECS secrets, real `health()`).

Earlier on this line:

- **The gap:** the Pomerium wildcard route was `allow_any_authenticated_user`, so
  the proxy enforced no per-workspace ownership.
- **The fix (external-authz → control plane):** a workspace **gate**
  (PEP, `services/workspace-gate`) fronts each workspace, verifies the Pomerium
  identity assertion against Pomerium's JWKS, and calls a control-plane **PDP**
  (`/api/internal/authz`) that maps `<ws-id>` subdomain → owner in DynamoDB and
  allows only the owner (by **email** — the identity the Auth.js portal IdP and
  the Pomerium proxy IdP share; `sub`/`oid` differ) or an admin. Workspaces now
  record `ownerEmail`. Pomerium binds the assertion `aud` to the workspace host
  (verified in v0.32.2 source: `authorize/evaluator/headers_evaluator_evaluation.go`),
  so a token can't be replayed across workspaces.
- **Proof:** core unit tests (host→id parse, access decision), the gate component
  test (HTTP + WebSocket, allow/deny/missing/PDP-down), the PDP integration test
  (DynamoDB ownership, admin bypass, replay/expiry/forgery), and an end-to-end
  test that verifies a REAL Pomerium assertion against Pomerium's real JWKS
  (`apps/web/app/api/internal/authz/route.e2e.ts`). The harness `pomerium.yaml`
  keeps the direct identity-gate route for the identity-layer suites; production
  routes the workspace `to:` through the gate (documented inline).
- No sockerless bugs found (Pomerium assertion + JWKS verified faithfully).

Current branch `feat/data-durability-container-drift` adds the two end-to-end
gaps from the latest review (no new product bugs found):

- **Data durability across a real scale-to-zero cycle** — through
  `WorkspaceService`: SSH writes a marker+checksum into the workspace, `stop()`
  snapshots, `connect()` wakes a NEW task from the snapshot, and SSH into the
  woken task confirms the file is byte-identical. Proves "your work survives
  scale-to-zero" end to end (the prior data-fidelity test only covered the EBS
  primitives via bare tasks). `packages/e2e/src/data-durability.e2e.ts`.
- **Reconciler CONTAINER drift sweep** — `reconciler-container.e2e.ts` now also
  seeds a workspace whose task is killed out-of-band; the scheduler-fired
  reconciler container's `runMaintenance` drift pass reconciles it to stopped
  (the in-process drift path was already covered by `drift-recovery.e2e.ts`).

A follow-up depth pass (PR #66, `feat/authz-matrix-concurrency-gc`) hardened the
remaining unhappy paths and found one more real bug:

- **delete-vs-wake task leak (real bug, fixed):** `remove()` used an
  unconditional `.delete()`, so a delete racing a wake could remove the record
  while `start()` launched a task — orphaning it. `remove()` is now
  version-conditioned (claim-the-delete-first) and defers snapshot reaping to GC
  (the single storage reaper, with a grace window), which also removes a
  snapshot-vs-wake race. Proven by `concurrency-pairs.integ.ts`.
- **CASL matrices:** the unit ability table is now exhaustive (every
  role × action × subject, 62 cases); a route-level matrix asserts each HTTP
  route enforces it (viewer denied across every verb, member can't mutate the
  catalog, unauth → 401).
- **Concurrency pairs:** stop-vs-snapshot, stop-vs-heartbeat, two-snapshots, and
  delete-vs-wake each prove exactly one winner + one clean conflict (no 500, no
  double side effect) under the version guard.
- **GC TOCTOU:** a freshly-created unreferenced volume within the grace window
  is never reaped (protects a create racing the sweep).
- **ssh-cert hardening:** the public-key contract now rejects malformed/oversized
  /multi-line/unknown-type keys with 400 at the boundary (was a 500 from
  `ssh-keygen`); no shell injection (key written to a file).

Current branch: `feat/hardening-races-drift-scale` (PR #65) — the unhappy-path
hardening pass (the failure modes the happy-path coverage didn't reach), each
found or fixed via a test:

- **Concurrent-wake task leak (real bug, fixed):** `WorkspaceService.persist`
  was an unconditional PutItem, so two simultaneous `connect`/`start` calls on
  a stopped workspace both launched a real ECS task and the loser's leaked
  forever. Added an optimistic-concurrency `version` field; every transition is
  a conditional update (`persistTransition`), the wake loser stops its own
  just-launched task and returns the winner's state (idempotent). E2e fires 5
  concurrent connects and asserts exactly one task survives.
- **Crash-consistency (fixed):** `create`/`start` launch the task before
  persisting; a persist failure now stops the just-launched task instead of
  orphaning it. Integ injects a DynamoDB write outage via the AWS SDK
  middleware stack.
- **Drift detection (new feature):** the reconciler now runs a drift sweep
  FIRST — a record whose task died out-of-band (crash/eviction) is reconciled
  via the new `ComputeProvider.taskState()` to `stopped` (snapshot → wake-able)
  or `error` (nothing to restore), so connect-info never hands out a dead ENI
  and the idle sweep never snapshots a released volume. E2e kills a task with
  raw ECS StopTask and asserts recovery.
- **Pagination / quota-bypass (real bug, fixed):** `WorkspaceService.list`
  used a single-page `.go()`; past DynamoDB's 1 MB page it truncated, which
  undercounted the per-owner quota check (a **quota bypass at scale**) and hid
  workspaces from the admin list. Now `pages: "all"`; integ seeds >1 MB and a
  reconciler integ sweeps a 450-record fleet.
- **Adversarial auth tests:** forged/tampered Pomerium session cookie stays
  gated; Auth.js callback rejects a missing-PKCE-verifier replay and a reused
  authorization code (PKCE is the GitHub provider's active check, verified in
  `@auth/core`); sshd rejects a wrong-CA and an expired certificate.
- **Heavy data fidelity:** 64 MiB random payload round-trips snapshot→restore
  byte-for-byte (`sha256sum -c`). **TLS storage adapter:** the EBS adapter runs
  over the TLS aws-sim with real CA trust in `e2e-https`.

Security review (`/security-review`) on the branch diff: no HIGH/MEDIUM
findings; the pagination fix is itself a quota-bypass remediation.

Upstream: sockerless **PR #550** (bleephub Actions follow-ups — cancellation,
runner groups, composite actions, runner-on-cloud volume translation) merged
and the submodule pin bumped to `9d43f3d`; none of it touches our surfaces
(we consume bleephub for OAuth only), and the bleephub auth e2e pass on it.

## What works (built, tested, merged to `main`)

- **Monorepo** (`@edd/*`, Turborepo+pnpm); `main` protected.
- **Core** (`@edd/core`): branded domain types, lifecycle state machine, pure functions
  (provision/stop/start/snapshot/`markActivity`/`planConnect`, base-image catalog),
  Storage/Compute ports + fakes.
- **Control plane** (`apps/web` + `@edd/control-plane`): `WorkspaceService` lifecycle
  (create/stop/start/connect/heartbeat/snapshot/remove) + `CatalogService`, over
  ElectroDB, CASL-gated API + `@edd/api-client`. Fargate managed-EBS model.
- **Auth** (`@edd/auth`): GitHub + Entra → group→role, both proven mock-free & swappable.
- **Portal** (`apps/web`): RBAC workspaces grid + lifecycle, base-image catalog admin
  page + create-from-catalog picker.
- **Reconciler**: idle scale-to-zero, scheduled snapshots, orphan GC (pure selectors).
  Container (`services/reconciler`): esbuild bundle; scheduler→ECS→container e2e proven.
- **Real adapters** (endpoint-only): `@edd/storage-ec2`, `@edd/compute-ecs`.
- **Deploy IaC** (`infra/terraform/modules/ecs-dev-desktop`): reusable parametric module
  (VPC + NAT [managed or fck-nat], KMS, DynamoDB+GSIs, ECR, ECS + Fargate + autoscaling,
  ALB + optional ACM/Route53, scheduler, IAM, logs). **`terraform-sim` CI job applies +
  destroys the full stack every PR** in the default, fck-nat, and DNS/TLS configs
  (resource/functional assertions + idempotency). Endpoint-only (§6.8). Real apply is AWS-gated.
- **Golden workspace image** (`infra/images/workspace/`): Node 20 + OpenVSCode Server
  v1.109.5, tini PID-1, OpenSSH `sshd` with trusted CA/principal enforcement,
  idle-agent (heartbeats every 120s, HMAC machine-auth), and multi-arch
  OpenVSCode asset selection.
- **Real adapter wiring** (`apps/web/lib/control-plane.ts`): `COMPUTE_PROVIDER=ecs`,
  `AUDIT_PROVIDER=cloudtrail`, `LOG_PROVIDER=cloudwatch`; fakes remain default.
- **SSH gateway** (`services/ssh-gateway`): standard `sshd` + ephemeral CA
  (`scripts/gen-ssh-ca.sh`); `TrustedUserCAKeys` + `AuthorizedPrincipalsFile` RBAC;
  connect-as-principal + authz-deny proven mock-free. PTY allocation tested (`-tt`).
- **SSH cert API** (`POST /api/workspaces/:id/ssh-cert`): control plane signs user's
  public key with `ssh-keygen -s`; returns short-lived cert for `dev-<workspaceId>` principal.
- **Wake-on-connect proxy**: `sshHost` (ENI private IP — routable since sockerless PR #518;
  overlapping-CIDR VPC fidelity improved by PR #519)
  stored on `Workspace`/DB; `GET /api/workspaces/:id/connect-info` returns `{host, port}`;
  `Dockerfile.proxy` + `wake-and-forward.sh` + `proxy-entrypoint.sh` ForceCommand gateway
  authenticating with per-workspace HMAC machine-auth (`EDD_GATEWAY_SECRET`).
  Full chain e2e: client SSH → proxy container → REAL control plane (wake from
  stopped) → nc → workspace node; the stub-CP variant remains as a component test.
- **Workspace CloudWatch log shipping**: `EcsComputeProvider` adds `awslogs` `logConfiguration`
  to every task definition; `ECS_LOG_GROUP_WORKSPACES` injected by Terraform.
- **Pomerium routing** (`infra/proxy`): identity-aware wildcard routing + authenticated
  proxy-pass (`X-Pomerium-Jwt-Assertion`) — both proven mock-free against azure-sim,
  over real TLS (Pomerium forces https in all absolute URLs), incl. a real-browser
  OIDC login (`test:pw:pomerium`).
- **Phase 8 (8A+8B+8C)**: admin console (health board, all-workspaces, Inspect, Overview,
  quotas, Logs/Audit); `@edd/cloudtrail-audit` + `@edd/cloudwatch-logs` endpoint-only
  adapters, integration-tested against the sim.
- **Test tiers**: unit/contract · integration (DynamoDB Local + process sim;
  route-level lifecycle/gateway-auth/admin-data suites) · e2e (data-fidelity,
  LIVE user journey through the real API on container-mode adapters, lifecycle,
  auth incl. Auth.js callback routes, Pomerium, OpenSSH gateway + real-CP wake
  chain, overlapping-CIDR awsvpc, reconciler container incl. real scale-to-zero,
  managed-EBS golden workspace SSH, ECS Exec smoke) · live admin observability
  route tests against sockerless AWS CloudTrail/CloudWatch · portal e2e
  (Playwright) · `e2e-https` (sims over TLS, real CA trust, no `--insecure`;
  incl. the Entra Auth.js callback leg) · manual `e2e-aws`.
- **Engineering quality**: typed `Result<T, DomainError>` channel; compile-time
  exhaustiveness guards; typed `data-testid` registry; `waitForDynamo` harness
  determinism; `knip` + `jscpd` code-health gates; SAST + Trivy.

## Deployed

Nothing on AWS — no cloud infrastructure provisioned.

## Immediate focus

1. **AWS account/region decision** (`DO_NEXT` #1) — the top blocker; unlocks
   everything real.
2. **Live-test candidates exhausted** (`docs/simulator-live-coverage.md`):
   browser Pomerium OIDC login landed as `test:pw:pomerium` (real-TLS Pomerium
   harness; Chromium completes gate → IdP → callback → workspace), after
   `test:pw:live` (browser lifecycle on real ECS compute). Only the optional
   ECS Exec workspace probe remains, gated on a product decision.
