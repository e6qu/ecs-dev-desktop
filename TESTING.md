# TESTING.md — ecs-dev-desktop

How we test. The rule (see `AGENTS.md` §0–§5): **TDD for new features**, and
**all code testable locally and in CI**. External dependencies sit behind
adapters with fakes; the real-AWS/IdP behaviors that no simulator can certify run
in a **manual** suite on `main`.

---

## Substrate decision

- **Primary integration substrate: [`sockerless`](https://github.com/e6qu/sockerless)**
  (its `simulators/aws` + `bleephub` GitHub server). It covers our
  ECS/ECR/DynamoDB/IAM/Route53/ACM/KMS control-plane surface **and actually
  executes containers** (Docker-API → local Docker), which LocalStack Community
  does not. We dogfood it.
- **When the simulator is missing/incorrect for something we need, we file (or
  comment on) an issue in `e6qu/sockerless`** and track it in `BUGS.md` under
  _External blockers_. Known today:
  - **EBS volume lifecycle + snapshots** — not implemented (sockerless **#347**).
    Blocks sim-level coverage of our core snapshot round-trip.
  - Compute/VPC/SG/LB are **metadata-only fakes** (sockerless #332–#336): no real
    network routing, SGs not enforced.
  - **No Azure Entra user-login OIDC** simulator (`bleephub` covers GitHub only).
- **LocalStack** is kept only as an optional cross-check where sockerless is
  immature; not a primary gate.

---

## Test tiers

### 1. Unit / contract — every commit, local + CI

Pure logic + adapters-with-fakes. No network, no Docker.

- `packages/authz` — CASL ability matrix (admin / group / user × every action).
- `packages/api-contracts` — Zod schema round-trips.
- `packages/core` — workspace lifecycle state machine (all transitions).
- `packages/auth` — claim/group → role mapping with synthetic IdP claims.
- **Adapter contract tests** run the _same_ suite against the fake and the real
  adapter, keeping them honest. The `StorageProvider` fake (filesystem/loopback)
  lets us TDD the **snapshot round-trip logic** today, before sockerless #347.

Tooling: **Vitest**.

### 2. Integration — every PR, local + CI (sockerless substrate)

| Concern                                      | Backed by                                             |
| -------------------------------------------- | ----------------------------------------------------- |
| ECS task lifecycle + **real container exec** | sockerless ECS backend + `simulators/aws`             |
| DynamoDB single-table + GSIs                 | **DynamoDB Local** (or sockerless `dynamodb.go`)      |
| ECR / IAM / Route53 / ACM / KMS (call-shape) | `simulators/aws`                                      |
| GitHub OAuth / Apps                          | **bleephub**                                          |
| Other OIDC (incl. Entra stand-in)            | **mock-oauth2-server** until a real Entra sim exists  |
| Teleport SSH                                 | **Teleport-in-Docker** + node container; assert audit |
| Identity-aware proxy                         | **Pomerium-in-Docker** with the mock IdP              |
| UI                                           | **Playwright** vs app with mocked API                 |

Proves wiring/call-shapes and (where sockerless executes containers) real task
behavior. Does **not** prove real EBS durability/latency, real network routing,
real IAM enforcement, or real Entra federation — that's tier 3.

### 3. `e2e-aws` — MANUAL, on `main` (real AWS/IdP)

Triggered via **`workflow_dispatch` on `main`** (not per-PR, not scheduled).
Guardrails: GitHub **OIDC→AWS role** (no static keys), unique run prefix,
**mandatory auto-teardown** even on failure, cost budget cap.

Exclusively certifies what no simulator can:

1. **EBS snapshot durability/latency** — write → snapshot → hydrate new task →
   bytes present; measure hydrate/lazy-load.
2. Real Fargate scheduling / ENI / cold-start.
3. Cold-start latency & 200+ load (k6/Locust).
4. Real GitHub-org + **Azure Entra** federation (live group claims).
5. ACM cert issuance + Route 53 DNS propagation.
6. IAM least-privilege actually enforcing (Access Analyzer / policy simulator).
7. KMS grants, cross-region snapshot copy, DR drills.

## Infrastructure tests

`terraform validate`, **`tflint`**, **`checkov`**, native **`terraform test`** in
CI on `infra/terraform`. Real `apply` runs only in the manual `e2e-aws` job.

## Local quickstart (wired in Phase 0)

```
pnpm test                  # tier 1 (unit + contract)
pnpm test:integ            # tier 2, brings up sockerless + DynamoDB Local + Docker
pnpm --filter <pkg> test   # one component in isolation
# tier 3 (e2e-aws): workflow_dispatch on main, or local only with explicit AWS creds
```
