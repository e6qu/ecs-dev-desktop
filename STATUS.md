# STATUS.md — ecs-dev-desktop

> Snapshot of where the project is right now. Update after every task.
> Past tense at PR close (see `AGENTS.md` §0).

**Last updated:** 2026-06-01

## Current phase

**Phase 0 — Foundations & repo scaffold** — *not yet started (planning complete).*

## What exists

- Planning and architecture were completed and recorded in `PLAN.md` and
  `AGENTS.md`.
- Core decisions were locked (compute, scale, auth, RBAC, SSH, state store, IaC,
  monorepo). See `AGENTS.md` §1.
- Continuity files were created.

## What is deployed / working

- Nothing deployed yet. No code or infrastructure has been provisioned.
- The repository is **not yet a git repository** and has no scaffolding beyond
  the planning/continuity docs.

## Immediate focus

- Confirm the open decisions in `DO_NEXT.md` (notably DynamoDB as the state
  store), then begin Phase 0 scaffolding.
