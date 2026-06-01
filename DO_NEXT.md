# DO_NEXT.md — ecs-dev-desktop

> Prioritized next tasks and open decisions awaiting the user.
> Update after every task; past tense at PR close for completed items.

---

## Open decisions (need the user)

1. **Confirm DynamoDB** as the state store (analysis favors DynamoDB + ElectroDB).
   *(Default if no objection: DynamoDB.)*
2. **VS Code distro:** confirm **code-server / OpenVSCode + Open VSX**, or flag
   any **MS-exclusive extensions** users depend on (Pylance, official Remote/C++).
3. **Identity-aware proxy:** confirm **Pomerium** (vs Authentik / in-house).
4. **Domain & DNS:** base domain for `*.devbox.<domain>` and DNS/cert owner.
5. **AWS account/region & data-residency** (gates Terraform baseline + manual
   `e2e-aws`).
6. **Heartbeat interval & idle threshold** (scale-to-zero tuning).
7. **sockerless issues:** confirm filing/commenting (see *Upstream* below) —
   notably whether an **Entra OIDC sim** is in sockerless's scope (EXT-003).

## Resolved decisions

- **Test substrate:** sockerless (sim + bleephub) primary; LocalStack optional
  cross-check.
- **Real-AWS tier:** manual `workflow_dispatch` on `main`.
- **License:** AGPL-3.0-or-later.

## Upstream (sockerless) — file/track

- [ ] Comment on **sockerless #347** with our requirement: snapshot **data**
      round-trip fidelity (bytes written to a volume must appear on a volume
      created from its snapshot) — `ecs-dev-desktop` persistence depends on it.
- [ ] **Verify in Phase 3** whether sockerless's Entra sim supports the
      interactive `/authorize`→login→code flow (token endpoint + JWKS already
      exist per #261/#272). File a precise issue only if an endpoint is missing
      (EXT-003) — do not assume "no Entra sim exists".

## Next tasks (Phase 0 — Foundations)

- [ ] Scaffold Turborepo + pnpm workspace; create `packages/config`.
- [ ] Stub all components so each builds in isolation.
- [ ] Define the `StorageProvider` **port** + filesystem/loopback **fake** to TDD
      the snapshot round-trip before sockerless #347 lands.
- [ ] Stand up the Tier-2 harness: sockerless + DynamoDB Local + Docker, wired to
      `pnpm test:integ`.
- [ ] Author `infra/terraform` baseline (VPC, ECS, ECR, DynamoDB + GSIs, KMS,
      IAM, remote state).
- [ ] CI: install → lint → typecheck → unit → integration; `terraform plan`.
- [ ] Manual `e2e-aws` workflow (`workflow_dispatch` on `main`) skeleton with
      OIDC→AWS role + auto-teardown.

## Blocked / waiting

- Terraform baseline gated on decision #5 (AWS account/region).
- Sim-level snapshot round-trip coverage gated on sockerless #347 (EXT-001).
