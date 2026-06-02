# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.
> Past tense for resolved entries at PR close (see `AGENTS.md` §0).

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

Simulator gaps that limit Tier-2 (integration) coverage. Not bugs in our code.
Per `AGENTS.md` §6.8 we file these upstream rather than work around them.

**EXT-002 — compute execution metadata-only ([#332](https://github.com/e6qu/sockerless/issues/332)
umbrella, [#333](https://github.com/e6qu/sockerless/issues/333) reopened).** The
deeper blocker — sockerless is a Docker-API daemon that runs real containers, but
compute (EC2/ECS task execution) isn't yet backed by real microVMs, so we cannot
run a workspace task or prove a mounted volume's _file_ data survives a snapshot
**at the sim level** (that fidelity is the real-AWS tier regardless). LB #334 and
SG #335 were resolved by PR #364. (Verify "closed" per-issue: EKS #348 / SES #349
were `not_planned`.)

**EXT-004 — from-source build/run friction (we filed, non-blocking).** We
consume sockerless **from source** (pinned submodule), so no release is needed —
[#363](https://github.com/e6qu/sockerless/issues/363) (cut a release) was closed.
While wiring it we filed: **[#366](https://github.com/e6qu/sockerless/issues/366)**
(the per-cloud sim Dockerfiles + `publish-container-images` use context
`simulators/<cloud>` but each module replaces `../realexec`, so the image build
fails — we work around it with `infra/sim/aws.Dockerfile` at repo-root context)
and **[#367](https://github.com/e6qu/sockerless/issues/367)** (the API-only
`SIM_RUNTIME=process` mode is undocumented; the sim otherwise FATALs without a
container runtime). Neither blocks us now.

## Resolved

**EXT-003 — Entra interactive `/authorize` flow (resolved 2026-06-02, upstream).**
We filed [#362](https://github.com/e6qu/sockerless/issues/362): `simulators/azure/auth.go`
advertised `authorization_endpoint` in discovery but served no GET
`/oauth2/v2.0/authorize`, so an OIDC relying party couldn't complete interactive
login. Fixed by sockerless PR #368 (auth-code flow with PKCE, state, response
modes, and RS256 id/access/refresh tokens). Entra interactive login is now
integration-testable against the from-source sim once the submodule is bumped to
include #368.

**EXT-001 — EBS snapshot→restore broken (resolved 2026-06-02, upstream).** We
filed [#359](https://github.com/e6qu/sockerless/issues/359): EBS snapshots never
transitioned `pending → completed`, so `CreateVolume(SnapshotId)` always failed
`IncorrectState`. Fixed upstream by sockerless PR #361 (settles snapshots on the
public `DescribeSnapshots` / `CreateVolume(SnapshotId)` paths). The same PR fixed
[#360](https://github.com/e6qu/sockerless/issues/360) (`DeleteItem
ReturnValues=ALL_OLD` returned empty attributes — relevant to our `remove()`).
The standard (endpoint-only) EBS lifecycle `StorageProvider` adapter is now
API-unblocked; running it in Tier-2 still waits on EXT-004, and proving a
volume's _file_ contents survive a snapshot still needs the compute layer
(compute e2e / real-AWS tier), since no standard EBS API reads volume files
without an attached task.

---

Template:

```
### BUG-NNN — <title>
- Severity: blocker | high | medium | low
- Status: open | in-progress | resolved (<date>)
- Component: <path>
- Repro / expected vs actual / fix: <...>
```
