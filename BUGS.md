# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.
> Past tense for resolved entries at PR close (see `AGENTS.md` §0).

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

Simulator gaps that limit Tier-2 (integration) coverage. Not bugs in our code.
Per `AGENTS.md` §6.8 we file these upstream rather than work around them.

**EXT-002 — compute/networking metadata-only.** #336 (VPC/ENI) landed; still
**open**: #332 (umbrella), #333 (compute → real Firecracker microVMs), #334 (LB
traffic + health), #335 (SG/nftables enforcement). This is the deeper blocker —
sockerless is a Docker-API daemon that runs real containers, and its compute is
not yet backed by real execution, so we cannot actually run a workspace task or
prove a mounted volume's data survives a snapshot **at the sim level**. That
fidelity is the manual real-AWS tier regardless. (Verify "closed" per-issue: EKS
#348 / SES #349 were `not_planned`.)

**EXT-003 — Entra interactive `/authorize` flow missing
([#362](https://github.com/e6qu/sockerless/issues/362), we filed).** Verified in
source: `simulators/azure/auth.go` serves the token endpoint + JWKS (#261, #272)
and its discovery doc advertises `authorization_endpoint`, but no GET
`/oauth2/v2.0/authorize` handler exists, so an Auth.js OIDC relying party can't
complete interactive login. Mock-OIDC covers Tier-2; real Entra is Tier-3.

**EXT-004 — no consumable/pinnable sockerless distribution
([#363](https://github.com/e6qu/sockerless/issues/363), we filed).** The
`publish-container-images` workflow only fires on `v*` tags (or manual dispatch)
and no `v*` tag exists (only a `wasm` pre-release), so no GHCR images are
published to pin. Tier-2 stays **DynamoDB Local only** until a versioned release
ships the simulator images (esp. `sockerless-simulator-aws`). This is the
"consume sockerless as a whole" gap, broader than any single cloud-API stub.

## Resolved

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
