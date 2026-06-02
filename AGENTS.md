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
6. **Prefer established libraries for security** (authn/authz/SSH/crypto/sessions).
   Don't hand-roll.
7. **Components build independently** (`pnpm --filter <name> build`).
8. **TDD**: failing test → make it pass → refactor. No feature without a test.

The engineering standards in §6 are also hard rules.

---

## 1. Architecture (locked)

| Dimension      | Decision                                                                   |
| -------------- | -------------------------------------------------------------------------- |
| Compute        | AWS **ECS Fargate** (light editor + build workloads), **200+** scale       |
| Persistence    | **EBS snapshot = unit of persistence** (state + snapshot + scale-to-zero)  |
| Idle policy    | **Scale-to-zero**: stop idle task → snapshot → hydrate on wake             |
| Auth / RBAC    | **Auth.js** (GitHub OAuth + Azure Entra), groups→roles; **CASL** abilities |
| SSH            | **Teleport** (auth, audit, recording, Remote-SSH)                          |
| Web / API      | **Next.js** — login + admin UI + control-plane API, **API-first**          |
| State store    | **DynamoDB** single-table + **ElectroDB**                                  |
| Images         | Curated **golden base images** in ECR; extensions via **Open VSX**         |
| IaC / monorepo | **Terraform** · **Turborepo + pnpm**                                       |
| Proxy          | Identity-aware proxy (Pomerium) for wildcard workspace routing             |
| License        | **AGPL-3.0-or-later** (SPDX header on new files)                           |

VS Code distro: **code-server / OpenVSCode Server** (MIT), not MS's server.

---

## 2. Components (each independently buildable)

```
apps/web/            Next.js: login + admin UI + control-plane API (API-first)
services/
  reconciler/        idle detection → scale-to-zero, snapshots, GC (worker)
  ssh-gateway/       Teleport config (declarative)
packages/
  core/              functional core: branded domain types, lifecycle state
                     machine, ports (Storage/Compute) + fakes, Clock
  control-plane/     WorkspaceService (imperative shell over core + db + ports)
  db/                DynamoDB single-table + ElectroDB entities
  storage-ec2/       real EBS StorageProvider over the EC2 API (sim or AWS)
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
  — supply-chain safeguard; `check-deps` CI enforces it). Declare only what a
  package imports; no unused deps.
- **Shell scripts**: pass `shellcheck`; run under bash **and** zsh, macOS **and**
  Linux. Portable only (`$0`-derived paths, `unset CDPATH`; no `BASH_SOURCE`,
  arrays, `pushd`, or GNU-only flags). The `shellcheck` CI job enforces it.

---

## 5. Testing

TDD; **ports-and-adapters** (every external dependency has a fake + a real
adapter). Detailed tooling in [`TESTING.md`](./TESTING.md).

| Tier            | Runs                         | Backed by                                             |
| --------------- | ---------------------------- | ----------------------------------------------------- |
| unit / contract | every commit                 | pure core + fakes                                     |
| integration     | every PR                     | DynamoDB Local, sockerless sim, mock-OIDC, Playwright |
| `e2e-aws`       | manual (`workflow_dispatch`) | real AWS account/region + real IdP                    |

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
