# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.
> Past tense for resolved entries at PR close (see `AGENTS.md` §0).

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

**None.** Every gap we hit has been fixed upstream (see Resolved).

Policy (`AGENTS.md` §6.8 + standing user directive): the **whole project** (product
code _and_ tests) must differ from the real-cloud path by **endpoint/base-domain
only** — no sim-specific endpoints, branches, flags, fixtures, tokens, fallbacks, or
workarounds. If something isn't expressible via a standard SDK/CLI/Terraform
provider, **file it upstream and halt** — never special-case around it.

## Resolved (sockerless, all fixed upstream — `we filed` unless noted)

| Gap (we filed) | What                                                                                                                                         | Fixed by |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| #359 / #360    | EBS snapshots never reached `completed`; `DeleteItem ALL_OLD` empty                                                                          | PR #361  |
| #334 / #335    | LB / SG enforcement (not we-filed; pre-existing)                                                                                             | PR #364  |
| #362           | Azure Entra had no GET `/oauth2/v2.0/authorize` (auth-code flow)                                                                             | PR #368  |
| #366 / #367    | per-cloud sim Dockerfile context broke `../realexec`; `SIM_RUNTIME=process` undocumented                                                     | PR #370  |
| #363           | "cut a release" — closed not-needed (we consume from source)                                                                                 | —        |
| #333           | EC2/ECS compute metadata-only → real Firecracker microVMs                                                                                    | PR #372  |
| #378           | EC2 `AttachVolume` metadata-only (didn't wire EBS into guest)                                                                                | PR #379  |
| #381           | control/data-plane coupling — containerized sim couldn't share managed-EBS bytes with sibling task containers; `CreateVpc` needed `nft`/caps | PR #382  |
| #384           | bleephub missing `GET /api/v3/user/teams` (blocked GitHub auth e2e)                                                                          | PR #385  |
| #387           | Entra id token had no `groups` claim / no Graph `memberOf` / no seeding                                                                      | PR #389  |
| #390           | #389's Entra group seeding was **sim-only** (`/sim/v1/...`) — not swappable; needed standard Graph provisioning + ROPC                       | PR #393  |
| #391           | bleephub `POST /user/orgs` isn't a real GitHub/GHES endpoint — needed standard `POST /admin/organizations`                                   | PR #393  |

Key outcomes: PR #382 made ECS managed EBS use **Docker named volumes** (so the
container-mode e2e runs with plain Docker — no KVM/`nft`), and VPC/Subnet store
metadata unconditionally. Pattern that worked well: precise filings (repro + code
pointer) get fixed within hours.

---

Template for a new bug:

```
### BUG-NNN — <title>
- Severity: blocker | high | medium | low
- Status: open | in-progress | resolved (<date>)
- Component: <path>
- Repro / expected vs actual / fix: <...>
```
