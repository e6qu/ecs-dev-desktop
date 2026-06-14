<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Running locally

How to run, develop, and test the app on your machine. The platform talks to AWS
and IdPs only through **coordinates** (endpoints + credentials), so the same code
runs against in-process fakes, the local [sockerless](https://github.com/e6qu/sockerless)
simulators, or real cloud by changing coordinates alone — no sim-specific code
paths (`AGENTS.md` §6.8/§6.9).

Every command below **reaps prior local state first** (`docker compose down
--remove-orphans -v` across the project), so a stale or half-finished previous run
never blocks the current one. Run `pnpm reap` anytime to clean up by hand.

## Prerequisites

- **Node 22+** and **pnpm** (`packageManager` pin in `package.json`).
- **Docker or podman** (for DynamoDB Local and the simulators).
- The sims build from the pinned submodule — clone with submodules:
  `git submodule update --init --recursive`.
- `pnpm install`.

## Tier 0 — fastest inner loop (fakes + DynamoDB Local)

```sh
pnpm dev
```

One command: reaps prior state → starts DynamoDB Local → ensures the table + a
base image (idempotent `dev-bootstrap`) → runs `next dev` on
**http://localhost:3700**. Compute/storage are in-process **fakes** (workspaces
"launch" instantly, nothing real is provisioned); persistence is real DynamoDB
Local; auth is **dev-auth**.

**Signing in (dev-auth).** With `EDD_DEV_AUTH=1` (the default for `pnpm dev`) the
app trusts two cookies — set them in the browser (DevTools → Application →
Cookies) to act as any user/role:

| Cookie         | Value                           |
| -------------- | ------------------------------- |
| `edd-dev-user` | any id, e.g. `dev`              |
| `edd-dev-role` | `admin` \| `member` \| `viewer` |

For API calls (curl) the same identity is accepted as headers:

```sh
curl -H 'x-edd-user-id: dev' -H 'x-edd-role: admin' http://localhost:3700/api/workspaces
```

## Tiers — add real surfaces by coordinates

Bring up extra local services with compose **profiles** (`EDD_DEV_PROFILES`) and
point the app at them with the standard coordinate env vars. Everything else is
unchanged — the app never knows it's a sim.

| Tier         | What's real                                                | Profile(s)     |
| ------------ | ---------------------------------------------------------- | -------------- |
| **local**    | nothing (fakes) — fastest                                  | _(none)_       |
| **+ GitHub** | real GitHub OAuth login (via `bleephub`, `:5555`)          | `github`       |
| **+ AWS**    | real EBS/ECS adapters against the sockerless sim (`:4566`) | `aws`          |
| **+ Entra**  | real Entra/Azure OIDC login (`:4568`)                      | `entra`        |
| **+ both**   | OAuth + real compute                                       | `"github aws"` |

`EDD_DEV_PROFILES` is a space-separated list; each token brings up one compose
profile in `docker-compose.dev.yml`. Copy-pasteable commands:

```sh
# + GitHub (real OIDC login via bleephub). Real OIDC ⇒ EDD_DEV_AUTH=0 + Auth.js secrets.
EDD_DEV_PROFILES=github EDD_DEV_AUTH=0 \
  AUTH_SECRET=dev-secret AUTH_GITHUB_ID=<id> AUTH_GITHUB_SECRET=<secret> \
  AUTH_GITHUB_API_URL=http://127.0.0.1:5555/api/v3 AUTH_GITHUB_URL=http://127.0.0.1:5555 \
  pnpm dev

# + AWS (real EBS/ECS adapters). ECS_SUBNETS + ECS_EBS_ROLE_ARN are REQUIRED
# (the provider fails loudly without them); any sim subnet id / role ARN works.
EDD_DEV_PROFILES=aws COMPUTE_PROVIDER=ecs AWS_ENDPOINT_URL=http://127.0.0.1:4566 \
  ECS_SUBNETS=subnet-local ECS_EBS_ROLE_ARN=arn:aws:iam::123456789012:role/ecsInfrastructureRole \
  pnpm dev

# + both = the union of the two env sets above with EDD_DEV_PROFILES="github aws".
```

Notes:

- **Real OIDC tiers (+ GitHub / + Entra)** set `EDD_DEV_AUTH=0` and need the
  Auth.js secrets shown above (`AUTH_SECRET`, the provider id/secret). To target
  **real** GitHub or Entra instead of the sims, change those same coordinates only
  — no code change.
- The **+ AWS** tier is for exercising the real adapter call shapes; the full
  container-mode workspace loop (real task containers, snapshot/restore) lives in
  the e2e tier below (`pnpm test:e2e:local`).
- The `github` profile (bleephub) builds from `infra/sim/`, not the submodule —
  the `git submodule update` prerequisite is strictly needed only for the `aws` /
  `entra` profiles.

## Running tests locally

Both reap prior state first and create resources idempotently (the integration
suites drop+create their tables), so a previously-interrupted run won't block them:

```sh
pnpm test                # unit + contract — no Docker
pnpm test:integ:local    # integration: tier-2 substrate (DynamoDB Local + AWS sim)
pnpm test:e2e:local      # e2e: container-mode sim + SSH harness (HEAVY — builds the ~3 GB image)
sh scripts/test-gate-e2e.sh  # live per-workspace authz: browser → Pomerium → gate (PEP)
                             # → control-plane PDP → upstream (self-contained, self-reaping)
pnpm reap                # tear everything down by hand
```

See [`TESTING.md`](../TESTING.md) for the full test-tier breakdown (incl. the
HTTPS, Pomerium, and manual real-AWS tiers) and the GitHub App e2e coordinates.

## Deploying

To run against **real AWS**, the same code targets the cloud by changing
coordinates alone. See the deployment runbook **[`docs/deploying.md`](./deploying.md)**
(and the [Deploying](../README.md#deploying) summary in the README).
