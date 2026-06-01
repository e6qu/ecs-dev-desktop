# DO_NEXT.md — ecs-dev-desktop

> Prioritized next tasks and open decisions awaiting the user.
> Update after every task; past tense at PR close for completed items.

---

## Open decisions (need the user)

1. **Confirm DynamoDB as the state store.** Analysis favors DynamoDB +
   ElectroDB (cheaper, fits access patterns). Confirm, or choose Aurora if you
   foresee heavy relational reporting. *(Default if no objection: DynamoDB.)*
2. **VS Code distro:** confirm **code-server / OpenVSCode Server + Open VSX** is
   acceptable, or flag any **MS-exclusive extensions** users depend on (Pylance,
   the official Remote/C++ bundles) — this is the one item that could force a
   different approach.
3. **Identity-aware proxy:** confirm **Pomerium** (vs Authentik / build-in-house)
   for wildcard workspace routing + IdP federation.
4. **Domain & DNS:** what base domain for workspaces (`*.devbox.<domain>`) and
   who manages DNS/cert issuance (ACM + Route 53?).
5. **AWS account/region & guardrails:** target account(s), home region, and any
   data-residency constraints for snapshots (affects cross-region DR copy).
6. **Heartbeat interval & idle threshold:** desired idle timeout before
   scale-to-zero, and acceptable cold-start latency on wake.

## Next tasks (Phase 0 — Foundations)

- [ ] `git init` the repo and add a base `.gitignore` (Node/Terraform).
- [ ] Scaffold Turborepo + pnpm workspace; create `packages/config`.
- [ ] Stub all components so each builds in isolation
      (`apps/web`, `services/*`, `packages/*`).
- [ ] Author `infra/terraform` baseline (VPC, ECS cluster, ECR, DynamoDB single
      table + GSIs, KMS, IAM, remote state backend).
- [ ] Deploy empty `apps/web` Next.js app to Fargate behind an ALB; `/healthz`.
- [ ] Wire CI: install → lint → typecheck → build → `terraform plan`.

## Blocked / waiting

- Phase 0 infra work is gated on decision #5 (AWS account/region).
