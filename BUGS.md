# BUGS.md — ecs-dev-desktop

> Open and resolved bugs, plus external blockers tracked upstream. Each entry:
> ID, severity, status, repro, notes. Past tense for resolved entries at PR close
> (see `AGENTS.md` §0).

## Open

_None yet — no application code has been written._

## External blockers (tracked upstream)

These are not bugs in our code; they are simulator gaps in `e6qu/sockerless` that
limit Tier-2 (integration) coverage until resolved. See `TESTING.md`.

### EXT-001 — sockerless AWS sim lacks EBS volume lifecycle + snapshots

- Upstream: **sockerless #347** (and epic #341) — both now **CLOSED**.
- Impact (was): our **core snapshot round-trip** (write → snapshot → hydrate →
  assert) could not be certified at the sim level.
- Status: **unblocked upstream.** Next: verify the sim's snapshot **data**
  fidelity and, once a sockerless image is published (EXT-004), implement a
  sockerless-backed `StorageProvider` adapter through the existing round-trip
  contract test. Until then: `StorageProvider` fake (Tier 1) + manual real-AWS
  (Tier 3).

### EXT-002 — sockerless compute/VPC/SG/LB are metadata-only

- Upstream: sockerless #332, #333, #334, #335, #336 — all **OPEN**.
- Impact: no real network routing; security groups not enforced; ENIs/LB traffic
  fabricated. Blocks **sim-level** real Fargate networking / ENI / proxy-routing
  tests. Does NOT block our control-plane or snapshot-logic testing.
- Status: open upstream; only relevant once we sim real Fargate networking / the
  identity-aware proxy. Real behaviour is the manual real-AWS (Tier 3) job anyway.

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
