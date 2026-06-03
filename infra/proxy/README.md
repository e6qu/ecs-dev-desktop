<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# proxy (Pomerium)

Wildcard workspace routing + identity-aware access is provided by **Pomerium**
(`AGENTS.md` §1): every workspace is reached at `<name>.devbox.<domain>` and access
is gated on a real OIDC identity. `pomerium.yaml` is the declarative config.

## e2e (`docker-compose.e2e.yml`)

A real Pomerium proxy runs in Docker with the sockerless **azure sim as its OIDC
IdP** and a workspace HTTP upstream. The e2e (`packages/e2e/src/proxy-routing.e2e.ts`)
asserts the production routing model:

- a public health route reaches the workspace upstream through Pomerium (200);
- any `<name>.devbox.<domain>` matches the **wildcard** workspace route but, without
  an identity, is redirected to sign in (the **identity gate**) — verified for two
  distinct subdomains.

Pomerium is the **real product** (not a simulator). For the e2e it runs with
`insecure_server` (plain HTTP listener) and all-zeros throwaway secrets; real
deployments terminate TLS, inject 32-byte secrets, and use a real domain + ACM
(blocked on the DNS decision, `DO_NEXT` #2).

Remaining: an authenticated request passing through with identity headers (needs a
browser-driven login — Playwright); Teleport/Pomerium sharing the same IdP session.
