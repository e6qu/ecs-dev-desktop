# TESTING.md — ecs-dev-desktop

How we test. The rule (see `AGENTS.md` §0–§5): **TDD for new features**, and
**all code testable locally and in CI**. External dependencies sit behind
adapters with fakes; the real-AWS/IdP behaviors that no simulator can certify run
in a **manual** suite on `main`.

---

## Substrate decision

- **Primary integration substrate: [`sockerless`](https://github.com/e6qu/sockerless)**
  (AWS simulator, Azure/Entra simulator, and `bleephub` GitHub server), **built
  from source** from the pinned `third_party/sockerless` submodule (no release
  awaited). AWS runs in two modes:
  - `SIM_RUNTIME=process` for fast API-surface integration and Terraform apply.
  - container mode for ECS/Fargate behavior that must execute real task
    containers, including awsvpc networking and scheduler-fired tasks.
- **When the simulator is missing/incorrect for something we need, we file (or
  comment on) an issue in `e6qu/sockerless`** and track it in `BUGS.md` under
  _External blockers_. Current sockerless blockers are cleared; the pin is
  PR #549 (`777ffd3`), which also fixed our #547/#548 Entra OIDC fidelity
  reports (`login_hint` user binding; `client_secret_basic`).
- **LocalStack** is kept only as an optional cross-check where sockerless is
  immature; not a primary gate.
- Live simulator coverage and candidate app surfaces are tracked in
  [`docs/simulator-live-coverage.md`](./docs/simulator-live-coverage.md).

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
  TDDs snapshot round-trip logic; the container-mode e2e tier proves data fidelity
  through a real task container where standard cloud APIs can observe it.

Tooling: **Vitest**.

### 2. Integration — every PR, local + CI (sockerless substrate)

| Concern                                      | Backed by                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| ECS task lifecycle + **real container exec** | sockerless AWS container mode                                                                                                               |
| ECS awsvpc networking                        | sockerless AWS container mode, including overlapping VPC CIDRs                                                                              |
| Reconciler schedule → container              | EventBridge Scheduler + ECS RunTask + CloudWatch Logs in the sim                                                                            |
| ECS Exec smoke                               | sockerless AWS container mode (`ExecuteCommand`)                                                                                            |
| DynamoDB single-table + GSIs                 | DynamoDB Local in app/e2e; sockerless DynamoDB in Terraform sim                                                                             |
| ECR / IAM / Route53 / ACM / KMS              | sockerless AWS process-mode Terraform apply + assertions                                                                                    |
| CloudTrail / CloudWatch Logs adapters        | sockerless AWS process mode                                                                                                                 |
| GitHub OAuth / Apps                          | `bleephub`                                                                                                                                  |
| Azure Entra Graph + OIDC                     | sockerless Azure/Entra simulator                                                                                                            |
| SSH (OpenSSH)                                | `sshd` in Docker + ephemeral SSH CA; cert auth + RBAC                                                                                       |
| SSH wake-on-connect proxy (component)        | OpenSSH proxy container + stub control plane + workspace node                                                                               |
| SSH wake-on-connect chain (real CP)          | OpenSSH proxy + production `next start` + DynamoDB Local                                                                                    |
| LIVE user journey (real API, no fakes)       | production `next start` + `COMPUTE_PROVIDER=ecs` on container-mode sim (idle-agent heartbeats incl.)                                        |
| Reconciler scale-to-zero (real task)         | seeded stale workspace + scheduler-fired sweep on container-mode sim                                                                        |
| Auth.js callback routes                      | real NextAuth handlers vs `bleephub` + Azure/Entra sim (Entra leg TLS-only → `e2e-https`)                                                   |
| Identity-aware proxy                         | real Pomerium in Docker + sockerless Azure/Entra OIDC                                                                                       |
| Per-workspace authz (PEP→PDP)                | browser → real Pomerium → workspace **gate** (PEP) → control-plane **PDP** → upstream (`docker-compose.gate.yml`; owner 200, non-owner 403) |
| UI                                           | Playwright vs built app with local/dev auth and local adapters                                                                              |
| UI on real compute (`test:pw:live`)          | Playwright vs built app with `COMPUTE_PROVIDER=ecs` on the container-mode sim (browser clicks launch/stop/wake real golden-image tasks)     |

Proves wiring/call-shapes and, in container mode, real task behavior. It does
**not** prove real EBS latency, real Fargate capacity/cold-start, real IAM
enforcement, or real IdP federation — that's tier 3.

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

CI runs `terraform fmt -check -recursive`, `init -backend=false`, and `validate`
for the module and complete example. The `terraform-sim` job also applies,
asserts, checks idempotency, and destroys the module against the live sockerless
AWS simulator in the default, fck-nat, and DNS/TLS configurations. Real AWS
`apply` remains in the manual `e2e-aws` tier.

## HTTPS e2e (TLS) — mock-free auth + SSH (`e2e-https` CI job)

The simulators normally serve plain HTTP (loopback). The `e2e-https` job runs the
auth + SSH paths the way real cloud always works — **over TLS with real
certificate trust** (no `--insecure`, no skipped verification):

- `scripts/gen-sim-tls-cert.sh` mints a self-signed CA + server cert (SANs cover
  `127.0.0.1`/`localhost` + the compose service names) into `temp/sim-tls`
  (gitignored — no key is committed).
- `docker-compose.https.yml` serves **all three sockerless sims over TLS** —
  azure-sim + aws-sim via `SIM_TLS_CERT`/`SIM_TLS_KEY`, bleephub via
  `BPH_TLS_CERT`/`BPH_TLS_KEY`. The OIDC discovery doc auto-advertises `https://`.
- `EDD_SIM_SCHEME=https` flips the `@edd/config` sim base URLs to `https`; the
  client trusts the CA via `NODE_EXTRA_CA_CERTS`.
- The **Entra** auth smoke (Graph provisioning + ROPC → id_token → group→role)
  runs over HTTPS; the **SSH** connect + authz-deny runs against the standard sshd
  workspace node (certificate auth via ephemeral CA).

```
sh scripts/gen-sim-tls-cert.sh
docker compose -f docker-compose.https.yml up -d --build --wait
docker compose -f docker-compose.ssh.yml up -d --build --wait
EDD_SIM_SCHEME=https NODE_EXTRA_CA_CERTS="$PWD/temp/sim-tls/ca.pem" \
  pnpm --filter @edd/web exec vitest run --config vitest.e2e.config.ts lib/entra-auth.e2e.ts
pnpm --filter @edd/ssh-gateway exec vitest run --config vitest.e2e.config.ts src/ssh-connect.e2e.ts
```

## Local quickstart

```
pnpm test                  # tier 1 (unit + contract) - no Docker

# process-mode tier 2: DynamoDB Local + from-source AWS/Entra/bleephub sims
docker compose -f docker-compose.tier2.yml up -d --build --wait
pnpm test:integ

# container-mode e2e: ECS task containers, awsvpc networking, scheduler -> RunTask,
# plus the real-control-plane chains (they run the production `next start` build —
# `pnpm build` covers it; the harness builds apps/web on demand if .next is missing)
pnpm build
docker build -f services/reconciler/Dockerfile -t edd-reconciler:e2e .
# Golden image collection: shared base, then the omnibus variant FROM it
# (tagged edd-workspace:e2e — the default image the e2e/live suites launch).
docker build -t edd-base:e2e infra/images/base
docker build --build-arg BASE=edd-base:e2e -t edd-workspace:e2e infra/images/omnibus
docker build -f services/ssh-gateway/Dockerfile.proxy -t edd-ssh-proxy:e2e .
sh scripts/gen-sim-tls-cert.sh   # Pomerium serves real TLS; cert mounted by compose
docker compose -f docker-compose.e2e.yml up -d --build --wait
sh scripts/gen-ssh-ca.sh
docker compose -f docker-compose.ssh.yml up -d --build --wait
RECONCILER_IMAGE=edd-reconciler:e2e PROXY_IMAGE=edd-ssh-proxy:e2e pnpm test:e2e
pnpm --filter web test:pw:live      # browser lifecycle on real ECS compute
pnpm --filter web test:pw:pomerium  # browser OIDC login through Pomerium (TLS)

sh scripts/test-gate-e2e.sh         # live per-workspace authz: browser → Pomerium
                                    # → gate (PEP) → control-plane PDP → upstream
                                    # (self-contained; docker-compose.gate.yml)

pnpm --filter <pkg> test   # one component in isolation
# tier 3 (e2e-aws): workflow_dispatch on main, or local only with explicit AWS creds
```

The sim is built from the pinned `third_party/sockerless` submodule — clone with
`git submodule update --init` (CI uses `submodules: recursive`).
