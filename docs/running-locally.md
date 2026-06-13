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

| Tier         | Command                                                                                                                                  | What's real                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **local**    | `pnpm dev`                                                                                                                               | nothing (fakes) — fastest                                    |
| **+ GitHub** | `EDD_DEV_PROFILES=github EDD_DEV_AUTH=0 AUTH_GITHUB_API_URL=http://127.0.0.1:5555/api/v3 AUTH_GITHUB_URL=http://127.0.0.1:5555 pnpm dev` | real GitHub OAuth login (via `bleephub`)                     |
| **+ AWS**    | `EDD_DEV_PROFILES=aws COMPUTE_PROVIDER=ecs AWS_ENDPOINT_URL=http://127.0.0.1:4566 pnpm dev`                                              | real EBS/ECS adapters (workspaces provision against the sim) |
| **+ both**   | `EDD_DEV_PROFILES="github aws" COMPUTE_PROVIDER=ecs AWS_ENDPOINT_URL=http://127.0.0.1:4566 … pnpm dev`                                   | OAuth + real compute                                         |
| **+ Entra**  | add `entra` to `EDD_DEV_PROFILES` (Azure/Entra OIDC sim on `:4568`)                                                                      | real Entra OIDC login                                        |

Notes:

- The **+ GitHub / + Entra** tiers exercise the real OIDC login, so set
  `EDD_DEV_AUTH=0` and provide the Auth.js secrets (`AUTH_SECRET`, the GitHub
  OAuth `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET`, etc.). To target **real** GitHub or
  Entra instead of the sims, just change those same coordinates — no code change.
- The **+ AWS** tier needs a deployment cluster/subnets; use it for adapter call
  shapes. The full container-mode workspace loop lives in the e2e tier below.

## Running tests locally

Both reap prior state first and create resources idempotently (the integration
suites drop+create their tables), so a previously-interrupted run won't block them:

```sh
pnpm test                # unit + contract — no Docker
pnpm test:integ:local    # integration: tier-2 substrate (DynamoDB Local + AWS sim)
pnpm test:e2e:local      # e2e: container-mode sim + SSH harness (HEAVY — builds the ~3 GB image)
pnpm reap                # tear everything down by hand
```

See [`TESTING.md`](../TESTING.md) for the full test-tier breakdown (incl. the
HTTPS, Pomerium, and manual real-AWS tiers) and the GitHub App e2e coordinates.

## Deploying

See **[Deploying](../README.md#deploying)** in the README and the Terraform module
([`infra/terraform/README.md`](../infra/terraform/README.md)).
