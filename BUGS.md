# BUGS.md — ecs-dev-desktop

> Open and resolved bugs, plus external blockers tracked upstream. Each entry:
> ID, severity, status, repro, notes. Past tense for resolved entries at PR close
> (see `AGENTS.md` §0).

## Open

_None yet — no application code has been written._

## External blockers (tracked upstream)

These are not bugs in our code; they are simulator gaps in `e6qu/sockerless` that
limit Tier-2 (integration) coverage until resolved. See `TESTING.md`.

### EXT-001 — sockerless AWS sim EBS lifecycle landed; snapshot **restore broken**

- **#347 (EBS lifecycle) is `completed`** and code-verified: `ec2.go` implements
  `CreateVolume`/`CreateSnapshot`/`DescribeSnapshots`/`DeleteSnapshot` with
  host-dir-backed data.
- **But snapshot→restore is blocked by a new bug: [sockerless #359](https://github.com/e6qu/sockerless/issues/359)**
  — snapshots never transition `pending → completed`, so `CreateVolume(SnapshotId)`
  always fails `IncorrectState`. We filed it (with SDK repro + code pointer).
- **Design note (standard APIs only — no sim special-casing):** the standard EBS
  API has **no** way to write/read a volume's _files_ without attaching it to a
  running task. So a standard `StorageProvider` adapter can do volume/snapshot
  **lifecycle** (EC2 API, endpoint-configurable) but **not** the data round-trip;
  proving data fidelity needs the **compute layer** (ECS task writes/reads the
  mounted volume) — a future compute e2e, or the manual real-AWS Tier 3.
- Status: a standard EBS lifecycle adapter is straightforward once **#359** lands;
  deferred until then. The fs-on-`SIM_EBS_DATA_DIR` hack was rejected (special case).

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
