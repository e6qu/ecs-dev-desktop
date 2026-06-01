# BUGS.md — ecs-dev-desktop

> Open/resolved bugs in **our** code, plus external blockers tracked upstream.
> Past tense for resolved entries at PR close (see `AGENTS.md` §0).

## Open

_None._

## External blockers (upstream — `e6qu/sockerless`)

Simulator gaps that limit Tier-2 (integration) coverage. Not bugs in our code.
Per `AGENTS.md` §6.8 we file these upstream rather than work around them.

**EXT-001 — EBS snapshot→restore broken ([#359](https://github.com/e6qu/sockerless/issues/359), we filed).**
EBS lifecycle (#347) landed, but snapshots never transition `pending →
completed`, so `CreateVolume(SnapshotId)` always fails `IncorrectState`. A
standard (endpoint-only) `StorageProvider` lifecycle adapter is straightforward
once this lands; deferred until then. Note: the standard EBS API can't read/write
a volume's _files_ without a running task, so **data fidelity needs the compute
layer**, not the storage port (compute e2e / real-AWS tier).

**EXT-002 — compute/LB/SG still metadata-only.** #336 (VPC/ENI) landed; still
open: #333 (compute → microVMs), #334 (LB traffic), #335 (SG enforcement). Only
blocks sim-level Fargate _execution_ and SG/LB behaviour — real behaviour is the
manual real-AWS tier regardless. (Verify "closed" per-issue: EKS #348 / SES #349
were `not_planned`.)

**EXT-003 — Entra interactive login unverified.** Token endpoint + JWKS exist
(#261, #272); the interactive `/authorize`→login→code flow an Auth.js RP needs is
unverified. Mock-OIDC covers Tier-2; real Entra is Tier-3. Verify in Phase 3 and
file a precise issue only if a specific endpoint is missing.

**EXT-004 — no consumable sockerless image.** Upstream has a
`publish-container-images` workflow but no usable GHCR image yet, so Tier-2 runs
**DynamoDB Local only**; wiring the sockerless backend (and the EXT-001 adapter)
waits on a published image.

## Resolved

_None yet._

---

Template:

```
### BUG-NNN — <title>
- Severity: blocker | high | medium | low
- Status: open | in-progress | resolved (<date>)
- Component: <path>
- Repro / expected vs actual / fix: <...>
```
