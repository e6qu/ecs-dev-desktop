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

- Upstream: **sockerless #347** (and epic #341).
- Impact: our **core snapshot round-trip** (write → snapshot → hydrate → assert)
  cannot be certified at the sim level. Mitigation: `StorageProvider` **fake**
  for round-trip logic in Tier 1, plus the manual real-AWS Tier 3 for true
  durability.
- Status: open upstream; watch + (optionally) contribute.

### EXT-002 — sockerless compute/VPC/SG/LB are metadata-only

- Upstream: sockerless #332–#336.
- Impact: no real network routing; security groups not enforced; ENIs
  fabricated. Integration tests must not depend on real packet flow / SG denial.
- Status: open upstream.

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
