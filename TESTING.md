# TESTING.md — ecs-dev-desktop

How we test. The rule (see `AGENTS.md` §0–§5): **TDD for new features**, and
**all code testable locally and in CI**. External dependencies sit behind
adapters with fakes; the real-AWS/IdP behaviors that no simulator can certify run
in a **manual** suite on `main`.

---

## Substrate decision

- **Primary integration substrate: [`sockerless`](https://github.com/e6qu/sockerless)**
  (its `simulators/aws` + `bleephub` GitHub server), **built from source** from a
  pinned `third_party/sockerless` submodule (no release awaited). It covers our
  ECS/ECR/DynamoDB/IAM/Route53/ACM/KMS control-plane surface; run with
  `SIM_RUNTIME=process` it serves the AWS API surface without a container runtime
  (real container _execution_ needs a runtime + sockerless #333). We dogfood it.
- **When the simulator is missing/incorrect for something we need, we file (or
  comment on) an issue in `e6qu/sockerless`** and track it in `BUGS.md` under
  _External blockers_. Known today:
  - **Compute (EC2/ECS) execution** is metadata-only (sockerless #332/#333): no
    real task/container execution, so a mounted volume's _file_ data round-trip
    can't be proven at the sim level (it's the real-AWS tier's job). EBS volume
    **lifecycle** + snapshots work (#347; restore fixed by #359); LB/SG enforced
    (#334/#335); VPC/ENI real (#336).
  - **No Azure Entra interactive `/authorize`** flow (sockerless #362); `bleephub`
    covers GitHub. Token + JWKS exist (#261/#272).
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
  TDDs the **snapshot round-trip logic**, incl. data fidelity the EC2 adapter
  can't cover without compute (sockerless #333).

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
pnpm test                  # tier 1 (unit + contract) — no Docker
# tier 2: start the harness first (DynamoDB Local + the from-source AWS sim), then test
docker compose -f docker-compose.tier2.yml up -d --build --wait
pnpm test:integ
pnpm --filter <pkg> test   # one component in isolation
# tier 3 (e2e-aws): workflow_dispatch on main, or local only with explicit AWS creds
```

The sim is built from the pinned `third_party/sockerless` submodule — clone with
`git submodule update --init` (CI uses `submodules: recursive`).
