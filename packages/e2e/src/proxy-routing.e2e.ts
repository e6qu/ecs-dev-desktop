// SPDX-License-Identifier: AGPL-3.0-or-later
import { request } from "node:http";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Identity-aware wildcard routing e2e against a REAL Pomerium proxy in Docker
 * (docker-compose.e2e.yml — Pomerium is the real product, not a simulator). It
 * proves the production routing model (AGENTS.md §1): every workspace is reachable
 * at `<name>.devbox.<domain>` and access is gated on a real OIDC identity (the
 * sockerless azure sim is the IdP).
 *
 * - A public health route reaches the workspace upstream through Pomerium (200).
 * - Any `<name>.devbox.<domain>` matches the wildcard workspace route but, without
 *   an identity, is redirected to sign in (the identity gate) — verified for two
 *   distinct subdomains, so it's genuinely wildcard, not a single host.
 */
const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 8089;
const ROUTE_DOMAIN = "devbox.localhost";
const HEALTH_HOST = `health.${ROUTE_DOMAIN}`;
const AUTHENTICATE_HOST = `authenticate.${ROUTE_DOMAIN}`;

interface Probe {
  status: number;
  location: string | undefined;
  body: string;
}

/** GET `/` at the proxy with an explicit Host header; do not follow redirects. */
function probe(host: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: PROXY_HOST, port: PROXY_PORT, path: "/", method: "GET", headers: { Host: host } },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => {
          body += c.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, location: res.headers.location, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
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
});
