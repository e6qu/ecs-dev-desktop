# BUGS.md — ecs-dev-desktop

> Open and resolved bugs, plus external blockers tracked upstream. Each entry:
> ID, severity, status, repro, notes. Past tense for resolved entries at PR close
> (see `AGENTS.md` §0).

## Open

_None yet — no application code has been written._

## External blockers (tracked upstream)

These are not bugs in our code; they are simulator gaps in `e6qu/sockerless` that
limit Tier-2 (integration) coverage until resolved. See `TESTING.md`.

### EXT-001 — sockerless AWS sim EBS volume lifecycle + snapshots — RESOLVED

- Upstream: **sockerless #347** (epic #341) — closed with `state_reason=completed`.
- **Verified** (closed ≠ done, so we checked the code, not just the issue):
  `simulators/aws/ec2.go` implements `CreateVolume`/`CreateSnapshot`/
  `DescribeSnapshots`/`DeleteSnapshot` with an `EC2Volume`/`EC2Snapshot` store and
  **host-directory-backed data** (`ebsVolumeHostDirPath`, `ebsSnapshotHostDirPath`,
  `ebsPrepareVolumeHostPath`) — so a write→snapshot→hydrate round-trip persists
  real bytes.
- Status: **unblocked.** Next: run a sockerless-backed `StorageProvider` adapter
  through our existing round-trip contract test — gated on EXT-004 (running the
  sim). Until then: `StorageProvider` fake (Tier 1) + manual real-AWS (Tier 3).

### EXT-002 — sockerless compute/SG/LB still metadata-only (partial)

- **#336 (VPC fabric / NIC/ENI/IP allocation): completed** — real ENI/IP now.
- Still **OPEN**: #333 (compute → Firecracker microVMs), #334 (LB traffic), #335
  (security-group enforcement), #332 (umbrella).
- Impact: blocks **sim-level** real Fargate task _execution_ and SG/LB behaviour —
  not our control-plane or snapshot-logic testing. Real behaviour is the manual
  real-AWS (Tier 3) job anyway.
- Note: several recent AWS-sim closes were `not_planned` (e.g. EKS #348, SES #349),
  i.e. rejected — don't assume "closed" means implemented; verify per-issue.

### EXT-004 — no published sockerless container image

- Upstream: sockerless ships a `publish-container-images` workflow, but no GHCR
  image is consumable yet.
- Impact: the Tier-2 harness cannot run the **sockerless backend** — it currently
  covers **DynamoDB Local only**. Blocks adopting sockerless as the integration
  substrate (and the now-unblocked EBS adapter, EXT-001).
- Status: watch for a published image; then wire `docker-compose.tier2.yml`.

### EXT-003 — Entra interactive authorization-code/login flow (verify)

- Upstream: token-endpoint + JWKS already exist (sockerless **#261**, **#272**,
  both closed). The **interactive `/authorize` → login → code** flow that an
  Auth.js OIDC relying party needs is **unverified**.
- Impact: Entra _user login_ may or may not be integration-testable locally.
- Mitigation: `mock-oauth2-server` stand-in in Tier 2; real Entra in Tier 3.
- Status: **verify in Phase 3**; file a precise issue only if a specific endpoint
  is missing. Do not file on the false premise that "no Entra sim exists".

## Resolved

_None yet._

---

### Entry template

```
### BUG-NNN — <short title>
- Severity: blocker | high | medium | low
- Status: open | in-progress | resolved (<date>)
- Component: apps/web | services/reconciler | infra/terraform | ...
- Repro: <steps>
- Expected vs actual: <...>
- Notes / fix: <...>
```
