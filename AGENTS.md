# AGENTS.md — ecs-dev-desktop

> Self-hosted cloud dev-environment platform: per-user **VS Code** workspaces on
> **AWS ECS Fargate**, with SSH, stateful+snapshottable storage, a login UI, and
> an admin control plane (self-hosted Coder / Codespaces).
> **`CLAUDE.md` is a symlink to this file.**

---

## 0. Rules of engagement — hard rules, read every time

An LLM's context is ephemeral (lost across compaction / fresh sessions). The
continuity files are the only durable memory; every issue must be treated as
live. Hence:

1. **Start of every task: read the continuity files** (§3) — the only source of
   truth for current state, bugs, and next steps.
2. **End of every task: sync the continuity files** (`STATUS`, `WHAT_WE_DID`,
   `BUGS`, `DO_NEXT`). Nothing is "done" until they reflect reality.
3. **Continuity prose is past tense at PR close** (describes what _was_ done), so
   concurrent branches merge without tense/intent conflicts.
4. **Ask when a decision is the user's** (architecture, dependency, security, or
   data-model trade-off) — surface options + a recommendation, then wait.
5. **Never ignore an error, warning, or anomaly — including a "pre-existing"
   one.** "Pre-existing" is unverifiable (see context note above); fix it, or
   record it in `BUGS.md`/`DO_NEXT.md`. Never silence or step around it.
   **Diagnose from evidence — the failing log or a local repro — never an assumed
   cause** (a CI failure is reproducible; reproduce it before "fixing" it).
6. **Prefer established libraries for security** (authn/authz/SSH/crypto/sessions).
   Don't hand-roll.
7. **Components build independently** (`pnpm --filter <name> build`).
8. **TDD**: failing test → make it pass → refactor. No feature without a test.
9. **File upstream issues only in `github.com/e6qu/sockerless`** — never open
   issues in any other external project (e.g. Pomerium, AWS, etc.).
   If a third-party tool has a limitation, record it in `BUGS.md` and work
   around it or wait; do not file in their tracker.
10. **Only one active branch and one active PR at a time.** This prevents agents
    from creating PRs or work streams casually and causing confusion about what is
    under review. Do not start parallel work on a second branch, and do not open a
    second PR (including a stacked PR) while another branch/PR is active. If a PR
    already exists for the current branch/work, keep delivering work as commits to
    that PR; never open a duplicate PR.

The engineering standards in §6 are also hard rules.

---

## 1. Architecture (locked)

| Dimension      | Decision                                                                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compute        | AWS **ECS Fargate** (light editor + build workloads), **200+** scale                                                                                                                                                                                                                          |
| Persistence    | **EBS snapshot = unit of persistence** (state + snapshot + scale-to-zero)                                                                                                                                                                                                                     |
| Idle policy    | **Scale-to-zero**: stop idle task → snapshot → hydrate on wake                                                                                                                                                                                                                                |
| Auth / RBAC    | **Auth.js** (GitHub OAuth + Azure Entra), groups→roles; **CASL** abilities                                                                                                                                                                                                                    |
| SSH            | **OpenSSH** (`sshd`); registered-key auth — gateway + workspace dual-trust via the control plane's `ssh-authorize`                                                                                                                                                                            |
| Web / API      | **Next.js** — login + admin UI + control-plane API, **API-first**                                                                                                                                                                                                                             |
| State store    | **DynamoDB** single-table + **ElectroDB**                                                                                                                                                                                                                                                     |
| Images         | Curated **golden base images** in ECR; extensions via **Open VSX**                                                                                                                                                                                                                            |
| IaC / monorepo | **Terraform** · **Turborepo + pnpm**                                                                                                                                                                                                                                                          |
| Editor proxy   | **Folded into the Next.js app** (custom server): path-based `app.<domain>/w/<id>/` → workspace editor, authorized off the Auth.js session (uid-ownership/admin); the proxy hands the browser a per-workspace OpenVSCode connection token (defence-in-depth). No Pomerium, no wildcard DNS/TLS |
| License        | **AGPL-3.0-or-later** (SPDX header on new files)                                                                                                                                                                                                                                              |

VS Code distro: **code-server / OpenVSCode Server** (MIT), not MS's server.

---

## 2. Components (each independently buildable)

```
apps/web/            Next.js: login + admin UI + control-plane API (API-first)
services/
  reconciler/        idle detection → scale-to-zero, snapshots, GC (worker)
  ssh-gateway/       OpenSSH sshd + SSH CA config; workspacePrincipal mapping
packages/
  core/              functional core: branded domain types, lifecycle state
                     machine, ports (Storage/Compute) + fakes, Clock
  control-plane/     WorkspaceService (imperative shell over core + db + ports)
  db/                DynamoDB single-table + ElectroDB entities
  storage-ec2/       real EBS StorageProvider over the EC2 API (sim or AWS)
  compute-ecs/       real Fargate ComputeProvider (managed EBS; sim or AWS)
  api-contracts/     Zod contracts — single source of API truth
  api-client/        typed HTTP client over the contracts
  authz/             CASL abilities (admin/member/viewer)
  auth/              IdP claim→role mapping
  config/            typed config: endpoints, ports, defaults, env schema
infra/terraform/     all AWS infra        infra/images/   golden base images
third_party/sockerless/   pinned submodule (Tier-2 AWS simulator, from source)
```

The Tier-2 AWS substrate is the **sockerless** simulator built from source
(`third_party/sockerless` submodule, its own `simulators/aws/Dockerfile`), run via
`docker-compose.tier2.yml` with `SIM_RUNTIME=process`. Consumed endpoint-only
(§6.8); no published release is awaited.

---

## 3. Continuity files

| File             | Purpose                                                         |
| ---------------- | --------------------------------------------------------------- |
| `STATUS.md`      | Where the project is **right now** (current phase, what works). |
| `DO_NEXT.md`     | Prioritized next tasks, **open decisions**, and **blockers**.   |
| `BUGS.md`        | Open/resolved bugs + **external blockers** (upstream issues).   |
| `WHAT_WE_DID.md` | Concise dated history of decisions and outcomes.                |
| `PLAN.md`        | Phased roadmap (deliverables + testing gate per phase).         |

Per task: read them first → do the work → update them (past tense at PR close).

---

## 4. Build, dependencies, shell

- `pnpm install`; `pnpm build|test|lint` via Turbo; per-package `pnpm --filter`.
- **Deps: the latest version that is ≥ 1 day old** (pnpm `minimumReleaseAge: 1440`
  — supply-chain safeguard; `check-deps` CI enforces it). A `check-deps` failure is
  the gate working, not a flake: a newer age-eligible version exists — bump it and
  commit the lockfile. Declare only what a package imports; no unused deps.
- **Lockfile integrity.** Any dependency change — _including_ moving a dep between
  `dependencies` and `devDependencies` — must regenerate + commit `pnpm-lock.yaml`. CI installs
  with `--frozen-lockfile`, so a stale lockfile fails fast across **every** job; the
  `pnpm lockfile in sync` pre-commit hook catches it locally. Regenerate the **Terraform**
  provider lock with `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64
-platform=darwin_amd64` (ALL platforms) — `terraform init -upgrade` records only the current
  platform's `h1:` hash, leaving the lock incomplete so `check-deps` nags on the Linux CI runner.
- **Shell scripts**: pass `shellcheck`; run under bash **and** zsh, macOS **and**
  Linux. Portable only (`$0`-derived paths, `unset CDPATH`; no `BASH_SOURCE`,
  arrays, `pushd`, or GNU-only flags). The `shellcheck` CI job enforces it.

---

## 5. Testing

TDD; **ports-and-adapters** (every external dependency has a fake + a real
adapter). Detailed tooling in [`TESTING.md`](./TESTING.md).

| Tier            | Runs                         | Backed by                                                                                                 |
| --------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| unit / contract | every commit                 | pure core + fakes                                                                                         |
| integration     | every PR                     | the from-source sockerless sim (`SIM_RUNTIME=process`, API surface)                                       |
| `e2e`           | every PR                     | the **container-mode** sockerless sim — executes real task containers (full workspace data-fidelity loop) |
| `e2e-aws`       | manual (`workflow_dispatch`) | real AWS account/region + real IdP                                                                        |

`e2e-aws` covers only what simulators **cannot**: EBS data durability/latency,
real Fargate/ENI/cold-start, perf & 200+ load, real GitHub/Entra federation,
ACM/DNS, IAM enforcement, KMS/DR, wake-on-connect. Policy: GitHub OIDC→AWS role,
unique prefix, mandatory teardown, cost cap.

Live simulator status and gaps live in `BUGS.md` → _External blockers_ (kept
there, not inlined here, so it doesn't go stale).

---

## 6. Engineering standards (hard rules; lint/CI-enforced)

**6.1 Strong typing.** No `any`, no `object`. No `@ts-ignore`/`@ts-nocheck`
(`@ts-expect-error` only with a written reason). Casts are exceptional — prefer
type guards / Zod parsing; no object-literal casts; `as const` is fine.
**Branded domain types over primitives** (`WorkspaceId`, `VolumeId`, `BaseImage`,
…) — bare primitives only in trivial local cases. Pass **domain objects**, not
untyped dicts; typed collections, not `unknown[]`.
**`interface` for object shapes and `Deps` ports; `type` for unions, brands,
and `z.infer`/`ReturnType` aliases.**

**6.2 No magic values; no hardcoded endpoints/ports.** Meaningful literals are
named, documented constants. Endpoints/ports/defaults live in the typed
`@edd/config` (so the same code hits the sim or real cloud by config alone).

**6.3 Lint.** typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`
(type-aware). Required CI check; no warnings tolerated.

**6.4 Functional core, imperative shell.** Decisions are **pure functions** (data
in → domain object out, no I/O, no doubles) in `@edd/core`; the thin **shell**
(`WorkspaceService`, route handlers, adapters) does the I/O. Maximize the core.

**6.5 Fail loudly; explicit exports.** No silent fallbacks (`?? x` / swallowed
`catch {}`) that hide errors — throw or return an explicit error; documented
named defaults are fine. No wildcard re-exports (`export *`) — explicit named
exports only.

**6.5a Version persisted state.** Any state that outlives a code change (localStorage/IndexedDB
blobs, DynamoDB items) carries a schema **version**; bump it whenever the shape changes and
discard-or-migrate older blobs on load — never read a stale shape into newer code (an absent field
then crashes on read). Loaders accept ONLY the current version. (See the demo's `STATE_VERSION`
gate, added after a stale blob blanked the live site.)

**6.6 Security gates (CI, required).** Semgrep SAST (fail on high/critical) and
Trivy deps/IaC/secret scan (fail on HIGH/CRITICAL; medium/low acceptable).

**6.7 Local pre-commit.** `pre-commit install` (pre-commit + commit-msg hooks):
format/type-check/lint/unit-tests/actionlint across all languages; a `commit-msg`
hook strips AI-attribution trailers. Pinned hook revs follow the ≥1-day-old rule.

**6.8 Simulators are endpoint-only (HARD RULE).** Code targeting sockerless or
LocalStack differs from the real-cloud path by **endpoint configuration only** —
no sim-specific branches, flags, or host-filesystem access. If standard SDK/API
behaviour against the sim differs from real cloud, that is a **simulator bug**:
**file it upstream** (`e6qu/sockerless`) and reference it; do not work around it.
Anything not expressible via standard cloud APIs (e.g. an EBS volume's file
contents) is validated through the compute layer or the real-AWS tier.

**6.9 Coordinates, not targets — the simulators do not exist (HARD RULE).** To the
app **and its tests**, sockerless/bleephub/LocalStack **do not exist**: there is no
notion of "sim vs. real" anywhere in app or test logic. The only thing that exists
is **coordinates** — the externally-supplied facts that point at a concrete target:
**endpoints/base URLs, credentials (keys, tokens, secrets), and resource
identifiers (account/tenant/org/repo names, app/installation ids, ARNs)**. The same
code and the same test hit a sockerless sim or the real cloud by **changing
coordinates alone**.

Non-negotiables:

- **No branches, names, or special cases for a sim.** No `if (sim)`, no
  `if (bleephub)`, no hardcoded sim hosts, no sim-only assertions, no helper or
  symbol named after a sim in app/test logic. A test must not be able to tell, or
  behave differently, by target.
- **Standard APIs only.** Reach every target through the same standard
  SDK/REST/web surface the real cloud exposes. **Never** use a sim's
  private/internal/operator endpoint (e.g. bleephub `/internal/*`) from app or test
  code — that is "the sim existing." If a target can only be set up through a
  non-standard path, that is an **upstream gap**: file it on `e6qu/sockerless` and
  **skip the test until coordinates can be supplied the standard way** — do not
  reach into the sim.
- **Coordinates in, from config/env.** Tests read coordinates from config/env
  (e.g. `AUTH_GITHUB_API_URL` + `EDD_GITHUB_APP_ID`/`EDD_GITHUB_APP_KEY` + a test
  org/repo; `AWS_ENDPOINT_URL`); supplying real-cloud coordinates targets the real
  cloud with **zero changes**. When required coordinates are absent, **skip** — never
  fall back to a sim shortcut.
- **Out-of-band setup belongs to the deployment, not the code.** Anything the real
  provider only creates out of band (a registered GitHub App, a hosted zone, an IdP
  tenant) is provisioned by bringing the target up (CI/compose/operator), which then
  hands the code the **same coordinate shape** the real cloud would — the app/test
  just consumes coordinates.
- **Interactive-only flows** with no non-interactive real equivalent (e.g. a
  username-only web login) are the one carve-out: their bootstrap may be driven by
  the harness, but the **assertions stay coordinate-driven** and the test still
  never branches on target.

**6.10 Tests own their time — no rollover flakes (HARD RULE).** A test must be
explicit about the side effects it depends on — **especially time** — and its
result must never change because the wall clock advanced (a day/week/month/year
rollover, or "now" drifting past a hardcoded date). Rules:

- **Control time in unit/pure tests.** Pass `now` in (the core takes it as a
  parameter) or inject a `Clock` fake; pin any verifier's clock too (e.g. jose
  `jwtVerify(..., { currentDate })`). The test is deterministic regardless of when
  it runs.
- **Compute relative to now when a live target validates real time.** A test that
  hits something checking the real clock (e.g. a target validating a JWT's `exp`)
  must derive its times from the current time — `Date.now()`, or `now ± delta` to
  force "expired"/"valid" — **never** a hardcoded near-term date that silently goes
  stale (that is exactly how a `nowSec = <fixed date>` JWT broke on a date rollover).
- **Hardcoded timestamps are fine only as inert inputs** — fixed values fed to
  pure logic or used as fixtures and **never compared against the real clock**.
