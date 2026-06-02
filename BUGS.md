# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.
> Past tense for resolved entries at PR close (see `AGENTS.md` §0).

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

**None block us.** Every gap we hit is fixed upstream (see Resolved). The
mock-free workspace data-fidelity e2e now runs locally + in CI against the
container-mode sim.

## Resolved

**bleephub `/user/teams` missing (resolved 2026-06-03, upstream).** We filed
[#384](https://github.com/e6qu/sockerless/issues/384): bleephub served org-scoped
teams but not `GET /api/v3/user/teams` (404) — the endpoint our
`fetchGithubTeamGroups` calls — blocking the mock-free GitHub auth e2e. Fixed by
PR #385 (`handleListAuthUserTeams`). The GitHub auth e2e now passes against
bleephub. (Aside also noted there: bleephub ships only an integration-test
Dockerfile; we build the server from `bleephub/cmd` with `-tags noui`.)

**EXT-005 — control/data-plane coupling (resolved 2026-06-02, upstream).** We
filed [#381](https://github.com/e6qu/sockerless/issues/381): a containerized sim
couldn't share managed-EBS volume bytes with the sibling task containers it
launched (`HostPath` bind-mount → mount empty → workload exits 1), and `CreateVpc`
hard-failed without data-plane host caps (`nft`/`CAP_NET_ADMIN`/`CAP_SYS_ADMIN`).
Fixed by sockerless PR #382: ECS managed EBS now uses Docker **named volumes**
(daemon-managed, mountable by sibling containers regardless of where the sim
runs), and VPC/Subnet creation stores metadata unconditionally (real netns only
best-effort when caps exist). **Verified**: our `packages/e2e` data-fidelity loop
(write → snapshot via `Ec2StorageProvider` → restore into a new task → marker
present) passes against the container-mode sim.

**#378 — EC2 `AttachVolume` was metadata-only (resolved 2026-06-02, upstream).**
We filed it: an attached EBS volume wasn't wired into the Firecracker guest, so
guest writes didn't persist/snapshot (inconsistent with the ECS-managed-EBS path).
Fixed by PR #379 (sparse block-image backing; `AttachVolume`/`DetachVolume`/
`ModifyVolume` patch the running guest's drives; snapshot/restore data round-trip
covered by the Firecracker smoke). Both EBS models now have data fidelity. (Never
blocked us — we use managed EBS.)

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
