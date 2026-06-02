# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.
> Past tense for resolved entries at PR close (see `AGENTS.md` §0).

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

**None open.** Every sockerless gap we hit has been fixed upstream (see Resolved
below). Per `AGENTS.md` §6.8 we file gaps upstream rather than work around them.

Caveat (not a blocker): real sim compute (#333) runs on **Firecracker microVMs +
KVM** with a non-`process` `SIM_RUNTIME`. Our default Tier-2 (macOS/podman,
`SIM_RUNTIME=process`, fast every-PR) has no `/dev/kvm`, so sim-level workspace
_execution_ and volume _file_-data fidelity need a **KVM-capable CI job or the
real-AWS tier** — not our default Tier-2. The API surface (EBS lifecycle,
DynamoDB, EC2 metadata) runs fine in process mode.

## Resolved

**EXT-002 — compute execution metadata-only (resolved 2026-06-02, upstream).**
sockerless was a Docker-API daemon whose compute (EC2/ECS) was metadata-only, so
a workspace task couldn't actually run. Fixed by PR #372 ([#333](https://github.com/e6qu/sockerless/issues/333)
— real Firecracker microVM lifecycle for EC2/ECS, TAP networking, IMDS, async
ECS `StopTask`). Earlier: LB #334 + SG #335 (PR #364), VPC/ENI #336. The umbrella
[#332](https://github.com/e6qu/sockerless/issues/332) is effectively complete
(all children done), pending closure. (Verify "closed" per-issue: EKS #348 / SES
#349 were `not_planned`.) See the KVM caveat above.

**EXT-004 — from-source build/run friction (resolved 2026-06-02, upstream).** We
consume sockerless **from source** (pinned submodule) — [#363](https://github.com/e6qu/sockerless/issues/363)
(cut a release) was closed as not-needed. While wiring it we filed
**[#366](https://github.com/e6qu/sockerless/issues/366)** (per-cloud sim
Dockerfiles + `publish-container-images` used context `simulators/<cloud>` but
each module replaces `../realexec`, so the image build failed) and
**[#367](https://github.com/e6qu/sockerless/issues/367)** (the API-only
`SIM_RUNTIME=process` mode was undocumented; the sim otherwise FATAL'd). Both
fixed by sockerless PR #370 (shared `simulators/` build context + `SIM_RUNTIME`
docs). We dropped our workaround Dockerfile and now build the upstream
`simulators/aws/Dockerfile` directly (submodule pinned at `41480ae`).

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
