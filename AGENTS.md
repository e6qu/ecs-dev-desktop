# AGENTS.md — ecs-dev-desktop

> Self-hosted cloud dev-environment platform: per-user **VS Code** workspaces on
> **AWS ECS Fargate**, with SSH access, stateful+snapshottable storage, a login
> UI, and an admin control plane. Think self-hosted Coder / Codespaces.

This file is the entry point for any human or AI agent working in this repo.
**`CLAUDE.md` is a symlink to this file** — keep them identical by construction.

---

## 0. Rules of engagement (read every time)

1. **Always read the continuity files before starting any task** (see §3). They
   are the source of truth for current state, open bugs, and what to do next.
2. **Keep the continuity files in sync after every task.** A task is not "done"
   until `STATUS.md`, `WHAT_WE_DID.md`, `BUGS.md`, and `DO_NEXT.md` reflect
   reality.
3. **Continuity files must be written in the past tense at the end of a pull
   request**, describing what _was_ done — never "we are doing X". This keeps
   merges to `main` consistent: every branch describes completed history, so
   concurrent PRs append rather than conflict on tense/intent.
4. **Ask the user questions when a decision is needed.** Do not silently pick an
   architecture, dependency, security model, or data-model trade-off that the
   user would reasonably want to weigh in on. Surface options and a
   recommendation, then wait.
5. **Prefer well-established libraries for anything security-sensitive**
   (authn, authz, SSH, crypto, session handling). Do not hand-roll.
6. **Components are independently buildable.** A change in one component must not
   require rebuilding another to validate it. Respect the package boundaries.
7. **Develop test-first (TDD).** For new features, write a failing test first,
   make it pass, then refactor. No feature code merges without a test that
   exercises it.
8. **All code must be testable locally and in CI.** Hide every external
   dependency (AWS, IdP, Teleport, the proxy) behind an adapter with a fake.
   Behavior only real AWS/IdP can prove runs in the gated `e2e-aws` suite. See
   [`TESTING.md`](./TESTING.md) and §5 below.

---

## 1. Architecture summary (decisions locked)

| Dimension           | Decision                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| Compute             | AWS **ECS Fargate** (light editor + build workloads)                                                          |
| Scale target        | **200+** concurrent workspaces                                                                                |
| Persistence model   | **EBS snapshot = unit of persistence** (stateful + snapshot + scale-to-zero in one mechanism)                 |
| Idle policy         | **Scale-to-zero**: stop idle task → snapshot → hydrate on wake                                                |
| Auth                | **GitHub OAuth + Azure Entra ID** (dual IdP), groups → roles                                                  |
| Authz / RBAC        | **CASL** ability model, shared by API + UI                                                                    |
| SSH                 | **Teleport** (auth, audit, session recording, Remote-SSH)                                                     |
| Web/API             | **Next.js** — login UI + admin UI + control-plane API (API-first)                                             |
| State store         | **DynamoDB** single-table + **ElectroDB** (see DO_NEXT to confirm)                                            |
| Workspace images    | **Curated golden base images** in ECR (Open VSX for extensions)                                               |
| IaC                 | **Terraform**                                                                                                 |
| Monorepo            | **Turborepo + pnpm workspaces**                                                                               |
| Reverse proxy / IAP | Identity-aware proxy (e.g. Pomerium) for wildcard workspace routing                                           |
| Testing             | **TDD**; ports-and-adapters; **sockerless** sim + bleephub per-PR; **manual** real-AWS e2e on `main` (see §5) |
| License             | **AGPL-3.0-or-later** (SPDX header on new source files)                                                       |

> **VS Code distro:** use **code-server** or **OpenVSCode Server** (MIT), _not_
> Microsoft's official server (marketplace ToS). Extensions via **Open VSX**.

---

## 2. Project structure & components

Each top-level component lives in its own directory and is **independently
buildable** (`pnpm --filter <component> build`). Turborepo orchestrates; nothing
requires a sibling to be built first beyond published workspace packages.

```
ecs-dev-desktop/
├── apps/
│   └── web/                 # Next.js: login UI + admin UI + control-plane API.
│                            #   API-first — the UI consumes the same API as
│                            #   external clients (no private back-channels).
├── services/                # Long-running / background components (not Next)
│   ├── reconciler/          # Idle detection, scale-to-zero, wake orchestration,
│   │                        #   scheduled snapshots, orphan GC. Minimal worker.
│   └── ssh-gateway/         # Teleport deployment + config (mostly declarative).
├── packages/                # Shared, independently-versioned libraries
│   ├── api-contracts/       # Zod schemas / OpenAPI — single source of API truth
│   ├── api-client/          # Typed client generated from contracts (UI + svcs)
│   ├── authz/               # CASL abilities + RBAC role/group definitions
│   ├── auth/                # Auth.js config: GitHub + Entra providers, claim→role
│   ├── db/                  # DynamoDB single-table schema + ElectroDB entities
│   ├── core/                # Domain types + workspace lifecycle state machine
│   └── config/              # Shared tsconfig / eslint / env schema
├── infra/
│   ├── terraform/           # VPC, ECS, ECR, DynamoDB, KMS, NLB/ALB, IAM, Teleport
│   └── images/              # Golden base image Dockerfiles + build/scan CI
├── PLAN.md                  # Phased roadmap (deliverables + testing per phase)
├── STATUS.md                # Continuity: current state snapshot
├── WHAT_WE_DID.md           # Continuity: log of done / tried / filed
├── BUGS.md                  # Continuity: open + resolved bugs
├── DO_NEXT.md               # Continuity: prioritized next tasks + open decisions
├── AGENTS.md                # This file
└── CLAUDE.md -> AGENTS.md   # Symlink
```

### Component responsibilities (the "what are all the components" map)

| Component                | Responsibility                                                                                                          | Builds to                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `apps/web`               | Login UI, admin UI, control-plane REST API (Next route handlers / server actions). Owns workspace lifecycle endpoints.  | Next.js app (ECS svc)    |
| `services/reconciler`    | Consumes activity signals, stops idle workspaces, wakes on demand, schedules snapshots, GCs orphaned volumes/snapshots. | Node worker (ECS svc)    |
| `services/ssh-gateway`   | Teleport config: enrolls workspaces, federates Entra/GitHub identity, records sessions, enables VS Code Remote-SSH.     | Teleport cluster (infra) |
| `packages/api-contracts` | Zod/OpenAPI contracts — the API-first source of truth.                                                                  | TS lib                   |
| `packages/api-client`    | Typed client over the contracts, used by UI and services.                                                               | TS lib                   |
| `packages/authz`         | CASL ability definitions; maps roles (admin / group / user) to permissions.                                             | TS lib                   |
| `packages/auth`          | Auth.js providers (GitHub + Entra), maps IdP groups/claims → roles.                                                     | TS lib                   |
| `packages/db`            | DynamoDB single-table design + ElectroDB entities + access patterns/GSIs.                                               | TS lib                   |
| `packages/core`          | Shared domain types + the workspace lifecycle state machine.                                                            | TS lib                   |
| `infra/terraform`        | All AWS infrastructure.                                                                                                 | Terraform state          |
| `infra/images`           | Golden workspace base images (code-server + sshd/Teleport agent + idle-agent).                                          | ECR images               |

---

## 3. Continuity files (keep in sync, past tense at PR close)

| File             | Purpose                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `STATUS.md`      | Snapshot of where the project is **right now** (current phase, what's deployed/working).                                   |
| `WHAT_WE_DID.md` | Append-only history: what was **done**, what was **tried** (incl. dead ends), and what was **filed** (bugs/issues raised). |
| `BUGS.md`        | Open and resolved bugs with repro + status.                                                                                |
| `DO_NEXT.md`     | Prioritized upcoming tasks and **open decisions awaiting the user**.                                                       |
| `PLAN.md`        | The phased plan. Update only when scope/phases change.                                                                     |

**Workflow contract for every task:**

1. Read `STATUS.md` → `DO_NEXT.md` → `BUGS.md` (and `PLAN.md` for context).
2. Do the work.
3. Update `WHAT_WE_DID.md` (done / tried / filed), `BUGS.md`, `STATUS.md`,
   `DO_NEXT.md`.
4. At PR close, ensure all continuity prose is **past tense** and describes
   completed facts.

---

## 4. Build / test conventions

- `pnpm install` at root; `pnpm build` / `pnpm test` / `pnpm lint` run via Turbo.
- Per-component: `pnpm --filter <name> <script>` — must succeed in isolation.
- **Dependencies stay on the latest version that is ≥ 1 day old** — pnpm
  `minimumReleaseAge: 1440` (`pnpm-workspace.yaml`) is a supply-chain safeguard
  that won't adopt a just-published (possibly malicious/broken) release. The
  `check-deps` CI job enforces freshness via `pnpm outdated`, which honours the
  age floor. Don't add an unused dependency; declare only what a package imports.
- Each phase in `PLAN.md` defines its own **deliverables** and **testing** gate;
  do not advance a phase until its testing gate is green.
- Security-sensitive code uses libraries (Auth.js, CASL, Teleport, AWS SDK) —
  flag in review any place we'd be rolling our own.
- **Shell scripts must pass `shellcheck` and run under both `bash` and `zsh`, on
  macOS and Linux** (the full matrix). Write portable POSIX-ish shell: no
  `BASH_SOURCE`/arrays/`pushd`/GNU-only flags; derive paths from `$0`; guard `cd`
  (`unset CDPATH`). The `shellcheck` CI job (ubuntu + macOS) enforces it.

---

## 5. Testing & TDD

**Develop test-first.** Every new feature: write a failing test → make it pass →
refactor. Detailed tooling lives in [`TESTING.md`](./TESTING.md).

### Ports-and-adapters (what makes TDD viable here)

Wrap every external dependency behind an interface in `packages/core`; provide a
**fake** (for unit/contract tests) and a **real** adapter (for integration). This
keeps ~80% of the system fully testable locally and in CI; the irreducible AWS/
IdP behavior is isolated behind adapters and covered by the gated `e2e-aws` suite.

### Test tiers

| Tier                | Runs                                       | Backed by                                                                                                          |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Unit / contract** | every commit, local + CI                   | pure logic + fakes (CASL, Zod, state machine, claim→role)                                                          |
| **Integration**     | every PR, local + CI                       | **sockerless** (`simulators/aws` + `bleephub`), DynamoDB Local, Teleport-in-Docker, mock-oauth2-server, Playwright |
| **`e2e-aws`**       | **manual (`workflow_dispatch`) on `main`** | real AWS account/region, real IdP smoke                                                                            |

**Substrate:** [`sockerless`](https://github.com/e6qu/sockerless) is the primary
integration substrate (it runs real containers, unlike LocalStack). **When the
simulator lacks/incorrectly models something we need, file or comment on an issue
in `e6qu/sockerless`** and track it in `BUGS.md` → _External blockers_. Known
today: EBS snapshots unimplemented (**#347**); compute/VPC/SG/LB are metadata-only
(#332–#336); Entra interactive login flow unverified (token endpoint/JWKS exist
per #261/#272). Until #347 lands, the `StorageProvider` **fake** TDDs the
snapshot round-trip logic.

**`e2e-aws` policy:** GitHub **OIDC→AWS role** (no static keys), unique run
prefix, **mandatory auto-teardown** even on failure, cost budget cap. Small and
parallel.

### What CANNOT be tested without real AWS/IdP (covered only by `e2e-aws`)

1. **EBS snapshot stateful round-trip** — write → snapshot → hydrate new task →
   data present. (Emulators mock the API, not the data/latency behavior.)
2. **Real Fargate scheduling / ENI / cold-start.**
3. **Cold-start latency & 200+ load** (performance numbers are real-env only).
4. **Real GitHub / Azure Entra federation** (live group claims, org membership).
5. **DNS wildcard + ACM cert issuance + Route 53.**
6. **IAM least-privilege actually enforcing.**
7. **KMS grants, cross-region snapshot copy, DR drills.**
8. **Wake-on-connect end-to-end** (real editor activity → heartbeat → wake).

Everything else (pure logic, RBAC, contracts, DynamoDB access patterns, UI,
adapter call-shapes) is fully TDD-able locally + in CI.

---

## 6. Engineering standards (enforced)

These are hard standards, enforced by lint/CI where possible and by review
otherwise. They deliberately favour type safety over TypeScript brevity.

### 6.1 Strong typing

- **No `any`. No `object`.** Use a precise type, a generic, `unknown` (then
  narrow), or `Record<K, V>` with concrete `K`/`V`. (`@typescript-eslint/no-explicit-any` = error; `object` banned.)
- **No `@ts-ignore` / `@ts-nocheck`.** `@ts-expect-error` only with a written
  justification, and only when there is genuinely no typed alternative.
- **Type assertions (`as`) are exceptional.** Prefer type guards, discriminated
  unions, and schema parsing (Zod) to _prove_ types. `as const` is fine; object-literal
  assertions are banned. If you must cast, comment why.
- **Domain types over primitives.** Identifiers and domain values are
  **branded/nominal types** — `WorkspaceId`, `OwnerId`, `BaseImage`, `SnapshotId`,
  `VolumeId`, `TaskId`, `Role`, etc. — not bare `string`/`number`. Bare primitives
  only in the most trivial, local cases. We accept the extra ceremony for the
  type safety (e.g. you cannot pass a `VolumeId` where a `SnapshotId` is expected).
- **No untyped objects/dicts across boundaries.** Pass **domain objects** with
  named, typed fields — never bare `Record<string, unknown>`/dictionaries between
  modules. Untyped shapes are allowed only at the very edge (raw JSON), where they
  are immediately parsed into a domain type (Zod `.parse`).
- **No untyped lists.** Collections are typed by their element domain type
  (`ReadonlyArray<Workspace>`, not `unknown[]`/`object[]`). A bare array is fine
  only where it is genuinely _just multiplicity_ of an already-typed element.

### 6.2 Magic values

- **No unexplained literals.** Numbers/strings with meaning are named
  **constants** (e.g. `IDLE_THRESHOLD_MS`, `DEFAULT_REGION`, `TABLE_NAME`), defined
  once near their domain and documented with a comment on _why_ that value.

### 6.3 Lint

- **typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`** (type-aware),
  plus the bans above. Lint is a **required CI check**; warnings are not tolerated
  in CI (treat as errors).

### 6.4 Functional core, imperative shell (FCIS)

- Structure code as a **pure functional core** + a thin **imperative shell**
  (Gary Bernhardt). All decisions/transformations are **pure functions** — data
  in, domain objects/decisions out, no I/O, no mutation, no side effects — so the
  core is unit-tested with **no test doubles**.
- The **shell** (route handlers, adapters, `WorkspaceService` orchestration) does
  the I/O: it gathers inputs, calls the core to compute the next state + the
  effects to perform, then enacts those effects. Keep it thin, with few branches.
- Practically: the lifecycle decisions (what state, what effects) live in the
  core (`@edd/core`); ECS/EBS/DynamoDB/HTTP calls live in the shell. Maximize the
  core, minimize the shell.

### 6.5 No silent fallbacks — fail loudly

- **Discourage fallbacks/defaults that mask errors.** If required input,
  config, or state is missing or invalid, **throw a clear error** (or return an
  explicit error response) rather than guessing a default and continuing. Surface
  problems at their source.
- A documented, intentional default (named constant) is fine; a silent `?? x` /
  swallowed `catch {}` that hides a real failure is not. Returning `null`/an
  empty result for a genuine "absent" case is fine; doing so to paper over an
  error is not.
- No wildcard re-exports (`export *`) either — see §6.1; explicit named exports
  keep the public surface deliberate.

### 6.6 Security gates (CI, required)

- **SAST** (Semgrep): fails the build on **high/critical** (ERROR-severity)
  findings.
- **Dependency + IaC + secret scan** (Trivy): fails on **HIGH/CRITICAL**
  vulnerabilities/misconfigurations. **Medium and low are acceptable** (reported,
  non-blocking).
- Combined with the existing `check-deps` (latest, ≥1-day-old) policy, this keeps
  the supply chain both fresh and vetted.

### 6.7 Local pre-commit

- The repo uses the **`pre-commit`** framework (`.pre-commit-config.yaml`). Run
  `pre-commit install` once (installs the `pre-commit` and `commit-msg` hooks).
- Hooks (fast, local): trailing-whitespace, end-of-file, LF line endings,
  yaml/json checks; **auto-format** every language (Prettier for JS/TS/JSON/YAML/
  MD, `shfmt` for shell, `terraform fmt`); **type-check** (TS via `pnpm build`,
  `terraform validate`); **lint** (eslint, actionlint); and **unit tests**
  (`pnpm test`). Wider integration/e2e tests run in CI, not here.
- A `commit-msg` hook (`scripts/strip-ai-attribution.sh`) **strips AI-attribution
  trailers** ("Generated with …", `Co-Authored-By:`/`Authored-by:` naming AI
  tools) so commits stay clean.
- **Pinned hook revs follow the ≥1-day-old-latest policy** (§6.5) — verify a
  rev is the newest release at least a day old before bumping.
