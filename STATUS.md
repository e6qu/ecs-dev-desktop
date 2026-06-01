# STATUS.md — ecs-dev-desktop

> Snapshot of where the project is right now. Update after every task.
> Past tense at PR close (see `AGENTS.md` §0).

**Last updated:** 2026-06-01

## Current phase

**Phase 0 — Foundations & repo scaffold** — *not yet started (planning + repo
bootstrap complete).*

## What exists

- Architecture and phased plan were recorded in `PLAN.md` and `AGENTS.md`; core
  decisions were locked (see `AGENTS.md` §1).
- The GitHub repo `e6qu/ecs-dev-desktop` was created (public) with the planning +
  continuity docs, and `main` was protected (PR required, no direct/force push,
  0 approvals).
- The local git identity was set to `e6qu` with the GitHub no-reply email; the
  repo pushes over HTTPS via the `gh` token (no `adrian-marza-monite` SSH path).
- A **TDD + testability strategy** was defined (`AGENTS.md` §5, `TESTING.md`):
  - Tier 1 unit/contract; Tier 2 integration on the **sockerless** substrate
    (sim + bleephub) every PR; Tier 3 real-AWS **manual on `main`**.
  - `sockerless` was evaluated as the integration substrate; gaps were found
    (EBS snapshots unimplemented — sockerless **#347**; compute/net metadata-only;
    no Entra OIDC sim). Tracked under *External blockers* in `BUGS.md`.
- Project licensed **AGPL-3.0-or-later**.

## What is deployed / working

- Nothing deployed. No application code or AWS infrastructure exists yet.

## Immediate focus

- Confirm the open decisions in `DO_NEXT.md` (DynamoDB; VS Code distro; proxy).
- File/track the sockerless simulator issues, then begin Phase 0 scaffolding.
