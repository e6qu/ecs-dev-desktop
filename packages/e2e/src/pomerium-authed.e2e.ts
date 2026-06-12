// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { authedGet, ROUTE_DOMAIN } from "./pomerium-auth-flow";

/**
 * Authenticated Pomerium proxy-pass e2e (mock-free, real proxy + OIDC sim).
 *
 * The azure-sim's `/oauth2/v2.0/authorize` endpoint immediately redirects back
 * with an authorization code (no interactive login page), so the entire OIDC
 * auth flow can be driven by a plain HTTP client that follows redirects while
 * maintaining a cookie jar (see `pomerium-auth-flow.ts`). Pomerium serves real
 * TLS on the published harness port (sim CA trusted, SNI = virtual host).
 *
 * Per §6.8: only the sim base URLs differ from a real-cloud deployment; this
 * flow is identical with real Entra (the same OIDC discovery → code → token
 * sequence, just against microsoftonline.com).
 */

const WORKSPACE_HOST = `ws-alice.${ROUTE_DOMAIN}`;

describe("Pomerium authenticated proxy-pass (real OIDC flow with azure-sim)", () => {
  it("completes the OIDC auth flow and proxies with X-Pomerium-Jwt-Assertion header", async () => {
    const { hop: response } = await authedGet(WORKSPACE_HOST);

    // The workspace-upstream (traefik/whoami) echoes all received headers in the
    // response body — Pomerium injects X-Pomerium-Jwt-Assertion for authenticated
    // requests.
    expect(response.status, "expected 200 from authenticated workspace request").toBe(200);
    expect(response.body, "expected X-Pomerium-Jwt-Assertion header in upstream echo").toMatch(
      /X-Pomerium-Jwt-Assertion/i,
    );
  });

  it("sets a Pomerium session cookie after authentication", async () => {
    // Drive the full auth flow and inspect the cookies the redirect chain set.
    const { cookieJar } = await authedGet(WORKSPACE_HOST);

    // Pomerium sets a signed session cookie (named `_pomerium` by default).
    const hasPomeriumCookie = [...cookieJar.keys()].some((k) =>
      k.toLowerCase().includes("pomerium"),
    );
    expect(hasPomeriumCookie, "expected a _pomerium session cookie after auth").toBe(true);
  });
});
