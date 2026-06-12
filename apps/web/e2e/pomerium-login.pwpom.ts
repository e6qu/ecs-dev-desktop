// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser OIDC login through Pomerium (the last live-coverage candidate): a
// REAL user agent follows the full redirect chain — workspace host → Pomerium
// sign_in → azure-sim authorize (code issued) → Pomerium callback (token
// exchange) → back to the workspace — with genuine browser cookie semantics.
// The HTTP-client e2e (packages/e2e/src/pomerium-authed.e2e.ts) drives the
// same flow with a hand-rolled client; this proves it in Chromium.
//
// Pomerium serves real TLS (it forces the https scheme in every absolute URL
// it builds — see infra/proxy/pomerium.yaml); Chromium trusts the harness key
// by SPKI pin and resolves the harness hostnames per
// playwright.pomerium.config.ts.
import { expect, test } from "@playwright/test";

const PROXY_PORT = 8443;
const WORKSPACE_URL = `https://ws-browser.devbox.localhost:${String(PROXY_PORT)}/`;

test("browser completes the Pomerium OIDC login and reaches the workspace upstream", async ({
  page,
  context,
}) => {
  // One navigation drives the whole chain: Pomerium gate → IdP → callback →
  // workspace. The upstream (traefik/whoami) echoes received headers as text.
  await page.goto(WORKSPACE_URL);

  // The browser ended back on the workspace host, not stuck on the IdP or the
  // authenticate service.
  expect(new URL(page.url()).hostname).toBe("ws-browser.devbox.localhost");

  // Pomerium injected the signed identity assertion into the proxied request.
  const body = await page.locator("body").innerText();
  expect(body).toMatch(/X-Pomerium-Jwt-Assertion/i);

  // Real browser cookie behavior: the Secure Pomerium session cookie is
  // stored for the workspace host after the flow.
  const cookies = await context.cookies(WORKSPACE_URL);
  expect(cookies.some((c) => c.name.toLowerCase().includes("pomerium"))).toBe(true);

  // The session survives a fresh navigation without another IdP round trip:
  // the second load must not bounce through the authenticate host.
  const hops: string[] = [];
  page.on("request", (req) => hops.push(new URL(req.url()).hostname));
  await page.goto(WORKSPACE_URL);
  expect(await page.locator("body").innerText()).toMatch(/X-Pomerium-Jwt-Assertion/i);
  expect(hops).not.toContain("authenticate.devbox.localhost");
});
