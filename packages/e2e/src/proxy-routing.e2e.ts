// SPDX-License-Identifier: AGPL-3.0-or-later
import { URL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { pomeriumRequest, POMERIUM_PORT, ROUTE_DOMAIN } from "./pomerium-proxy";

/**
 * Identity-aware wildcard routing e2e against a REAL Pomerium proxy in Docker
 * (docker-compose.e2e.yml — Pomerium is the real product, not a simulator). It
 * proves the production routing model (AGENTS.md §1): every workspace is reachable
 * at `<name>.devbox.<domain>` and access is gated on a real OIDC identity (the
 * sockerless azure sim is the IdP). Transport is real TLS with the harness CA
 * trusted (`pomerium-proxy.ts`).
 *
 * - A public health route reaches the workspace upstream through Pomerium (200).
 * - Any `<name>.devbox.<domain>` matches the wildcard workspace route but, without
 *   an identity, is redirected to sign in (the identity gate) — verified for two
 *   distinct subdomains, so it's genuinely wildcard, not a single host.
 */
const HEALTH_HOST = `health.${ROUTE_DOMAIN}`;
// The externally-visible authenticate host carries the published harness port
// (authenticate_service_url in infra/proxy/pomerium.yaml).
const AUTHENTICATE_HOST = `authenticate.${ROUTE_DOMAIN}:${POMERIUM_PORT.toString()}`;

interface Probe {
  status: number;
  location: string | undefined;
  body: string;
}

/** GET `/` at the proxy for a virtual host; do not follow redirects. */
async function probe(host: string): Promise<Probe> {
  const res = await pomeriumRequest(new URL(`https://${host}/`));
  const location = res.headers.location;
  return {
    status: res.status,
    location: Array.isArray(location) ? location[0] : location,
    body: res.body,
  };
}

describe("Pomerium identity-aware wildcard routing (mock-free, real proxy)", () => {
  // Pomerium has no compose healthcheck; wait until it serves the public route.
  beforeAll(async () => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      // Readiness retry: a connection refused before Pomerium is listening is
      // expected, not a swallowed error — failure surfaces as the timeout throw.
      const ready = await probe(HEALTH_HOST)
        .then((r) => r.status === 200)
        .catch(() => false);
      if (ready) return;
      if (Date.now() > deadline) throw new Error("Pomerium did not become ready");
      await new Promise((r) => setTimeout(r, 1500));
    }
  });

  it("routes the public health host through to the workspace upstream", async () => {
    const res = await probe(HEALTH_HOST);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("gates an unauthenticated workspace subdomain behind sign-in", async () => {
    const res = await probe(`ws-alice.${ROUTE_DOMAIN}`);
    expect(res.status).toBe(302);
    expect(res.location).toBeDefined();
    const target = new URL(res.location ?? "");
    expect(target.host).toBe(AUTHENTICATE_HOST);
    expect(target.pathname).toBe("/.pomerium/sign_in");
    // The gate preserves the originally-requested workspace URL to return to.
    expect(target.searchParams.get("pomerium_redirect_uri")).toContain(`ws-alice.${ROUTE_DOMAIN}`);
  });

  it("applies the same gate to any subdomain (genuinely wildcard)", async () => {
    const res = await probe(`ws-bob.${ROUTE_DOMAIN}`);
    expect(res.status).toBe(302);
    expect(new URL(res.location ?? "").pathname).toBe("/.pomerium/sign_in");
  });

  it("a forged session cookie does not pass the gate (and is not a 500)", async () => {
    // Garbage in the session slot must behave like no session: redirect to
    // sign-in, never proxy to the upstream, never crash.
    const forged = await pomeriumRequest(new URL(`https://ws-mallory.${ROUTE_DOMAIN}/`), {
      Cookie: "_pomerium=AAAA.BBBB.CCCC",
    });
    expect(forged.status).toBe(302);
    expect(forged.body).not.toMatch(/X-Pomerium-Jwt-Assertion/i);

    // A structurally-valid-looking but unsigned JWT is equally worthless.
    const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "mallory", email: "mallory@example.com" }),
    ).toString("base64url");
    const tampered = await pomeriumRequest(new URL(`https://ws-mallory.${ROUTE_DOMAIN}/`), {
      Cookie: `_pomerium=${header}.${payload}.AAAA`,
    });
    expect(tampered.status).toBe(302);
    expect(tampered.body).not.toMatch(/X-Pomerium-Jwt-Assertion/i);
  });
});
