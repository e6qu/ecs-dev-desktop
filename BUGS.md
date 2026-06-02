# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.
> Past tense for resolved entries at PR close (see `AGENTS.md` §0).

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

| Filed                                                 | What                                                                                                                                 | Blocks                                     | Status   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | -------- |
| [#387](https://github.com/e6qu/sockerless/issues/387) | Azure/Entra sim id token has no `groups` claim, no Graph `memberOf`, no user/group seeding (identity claims are hardcoded constants) | Entra mock-free auth e2e (group→role RBAC) | **open** |

Policy (`AGENTS.md` §6.8 + standing user directive): consume the sim endpoint-only,
**file gaps upstream and halt** pending the fix — never work around them. #387 is
the direct Entra analog of the bleephub gap fixed in #384 / PR #385.

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
