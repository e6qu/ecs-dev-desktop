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
  PR #593 (`fcb58281`), which fixed the #590/#591/#592 conformance gaps from the
  focused fidelity pass (EBS `DescribeSnapshots` pagination, `CreateVolume` AZ
  validation, ECS `ClusterNotFoundException`).
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

> **jscpd (copy-paste check) scans test files too** — there is no test exclusion, and the pre-commit
> hook + CI fail over ~1% duplication. So parallel suites (e.g. the OpenVSCode + Monaco live-flow
> e2e) should **share a fixture** (see `packages/e2e/src/live-editor-fixture.ts`) rather than
> duplicate the setup/boilerplate — intentional pressure toward DRY tests, not a quirk to work around.

### 2. Integration — every PR, local + CI (sockerless substrate)

| Concern                                      | Backed by                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| ECS task lifecycle + **real container exec** | sockerless AWS container mode                                                                                                           |
| ECS awsvpc networking                        | sockerless AWS container mode, including overlapping VPC CIDRs                                                                          |
| Reconciler schedule → container              | EventBridge Scheduler + ECS RunTask + CloudWatch Logs in the sim                                                                        |
| ECS Exec smoke                               | sockerless AWS container mode (`ExecuteCommand`)                                                                                        |
| DynamoDB single-table + GSIs                 | DynamoDB Local in app/e2e; sockerless DynamoDB in Terraform sim                                                                         |
| ECR / IAM / Route53 / ACM / KMS              | sockerless AWS process-mode Terraform apply + assertions                                                                                |
| CloudTrail / CloudWatch Logs adapters        | sockerless AWS process mode                                                                                                             |
| GitHub OAuth / Apps                          | `bleephub`                                                                                                                              |
| Azure Entra Graph + OIDC                     | sockerless Azure/Entra simulator                                                                                                        |
| SSH (OpenSSH)                                | `sshd` in Docker; registered-key auth via the control plane (`ssh-authorize`)                                                           |
| SSH wake-on-connect proxy (component)        | OpenSSH proxy container + stub control plane + workspace node                                                                           |
| SSH wake-on-connect chain (real CP)          | OpenSSH proxy + production `next start` + DynamoDB Local                                                                                |
| LIVE user journey (real API, no fakes)       | production `next start` + `COMPUTE_PROVIDER=ecs` on container-mode sim (idle-agent heartbeats incl.)                                    |
| Idle-agent heartbeat resumption              | the real `idle-agent.sh` driven against a togglable stub control plane (`@edd/e2e` `test:integ`, no container/sim)                      |
| Reconciler scale-to-zero (real task)         | seeded stale workspace + scheduler-fired sweep on container-mode sim                                                                    |
| Auth.js callback routes                      | real NextAuth handlers vs `bleephub` + Azure/Entra sim (Entra leg TLS-only → `e2e-https`)                                               |
| Editor proxy authorization                   | path-based `/w/<id>/` proxy folded into the app (`apps/web/lib/workspace-proxy.ts`); uid-ownership/admin off the Auth.js session        |
| UI                                           | Playwright vs built app with local/dev auth and local adapters                                                                          |
| UI on real compute (`test:pw:live`)          | Playwright vs built app with `COMPUTE_PROVIDER=ecs` on the container-mode sim (browser clicks launch/stop/wake real golden-image tasks) |

Proves wiring/call-shapes and, in container mode, real task behavior. It does
**not** prove real EBS latency, real Fargate capacity/cold-start, or real IdP
federation — that's tier 3. (Call-time IAM **enforcement** logic is now proven
earlier, at the integration tier, against the sim's authorization gate — see below.)

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
6. The **real AWS IAM engine** enforcing our policies on the live deployment
   (condition keys at scale, Access Analyzer). The call-time enforcement _logic_
   — a registered principal's ungranted call is denied — is now proven at the
   integration tier against the sim's authorization gate (sockerless #659;
   `packages/storage-ec2/src/iam-enforcement.integ.ts`), so e2e-aws narrows to
   certifying the real IAM service rather than first-proving denial.
7. KMS grants, cross-region snapshot copy, DR drills.

**Status — first slice wired (`.github/workflows/e2e-aws.yml`).** The `ebs` job
runs `packages/e2e/src/aws-ebs-smoke.ts`, a thin wrapper over `runEbsSmoke`
(`@edd/storage-ec2`): create gp3 volume → snapshot → measure real completion
latency → restore a new volume → assert lineage, with no compute/ECR so teardown
is trivial. **Coordinate-driven, so the logic is not "untested until AWS":** the
**same** `runEbsSmoke` is exercised against the sockerless sim by the `integration`
job (`packages/storage-ec2/src/ebs-smoke.integ.ts`, which also asserts the `finally`
teardown deleted everything), and against real AWS here — differing only by
`AWS_ENDPOINT_URL` (set → sim; absent → real). What's real-AWS-only is the
**latency/durability fidelity**, not the round-trip logic. The smoke deletes its own
resources in `finally`; the workflow **also** sweeps everything tagged
`edd-e2eaws-run=<run-id>` on `always()`, behind a 30-min timeout (cost guardrail).
To run: set repo variables **`E2E_AWS_ROLE_ARN`** (an OIDC-assumable role with EC2
EBS perms) and optionally `E2E_AWS_REGION`, then dispatch the workflow on `main`
with input **`confirm=RUN`**. Items 2–7 above are added as further jobs once this is
validated against a real account (DO_NEXT #1).

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
  runs over HTTPS. The **dual-trust SSH** proxy e2e is self-contained — it
  docker-runs its own workspace node + gateway proxy against an in-process stub.

```
sh scripts/gen-sim-tls-cert.sh
docker compose -f docker-compose.https.yml up -d --build --wait
EDD_SIM_SCHEME=https NODE_EXTRA_CA_CERTS="$PWD/temp/sim-tls/ca.pem" \
  pnpm --filter @edd/web exec vitest run --config vitest.e2e.config.ts lib/entra-auth.e2e.ts

docker build -f services/ssh-gateway/Dockerfile.proxy -t edd-ssh-proxy:e2e .
docker build -f services/ssh-gateway/Dockerfile.node -t edd-workspace-node:e2e .
PROXY_IMAGE=edd-ssh-proxy:e2e NODE_IMAGE=edd-workspace-node:e2e \
  pnpm --filter @edd/ssh-gateway exec vitest run --config vitest.e2e.config.ts src/ssh-proxy.e2e.ts
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
docker build -f services/ssh-gateway/Dockerfile.node -t edd-workspace-node:e2e .
docker compose -f docker-compose.e2e.yml up -d --build --wait
RECONCILER_IMAGE=edd-reconciler:e2e PROXY_IMAGE=edd-ssh-proxy:e2e \
  NODE_IMAGE=edd-workspace-node:e2e pnpm test:e2e
pnpm --filter @edd/web test:pw:live  # browser lifecycle on real ECS compute
                                    # (also exercises the in-app /w/<id>/ editor proxy)

pnpm --filter <pkg> test   # one component in isolation
# tier 3 (e2e-aws): workflow_dispatch on main, or local only with explicit AWS creds
```

The sim is built from the pinned `third_party/sockerless` submodule — clone with
`git submodule update --init` (CI uses `submodules: recursive`).
