// SPDX-License-Identifier: AGPL-3.0-or-later
import { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  collectResponse,
  pomeriumRequest,
  ROUTE_DOMAIN,
  type ProxyResponse,
} from "./pomerium-proxy";

/**
 * Authenticated Pomerium proxy-pass e2e (mock-free, real proxy + OIDC sim).
 *
 * The azure-sim's `/oauth2/v2.0/authorize` endpoint immediately redirects back
 * with an authorization code (no interactive login page), so the entire OIDC
 * auth flow can be driven by a plain HTTP client that follows redirects while
 * maintaining a cookie jar. Pomerium serves real TLS on the published harness
 * port (`pomerium-proxy.ts`: sim CA trusted, SNI = virtual host).
 *
 * Flow:
 *  1. GET ws-alice.devbox.localhost → Pomerium: no session → 302 to
 *     https://authenticate.devbox.localhost:8443/.pomerium/sign_in?...
 *  2. Follow sign_in → Pomerium: redirects to azure-sim authorize URL.
 *  3. azure-sim: immediately redirects to the Pomerium callback with the code.
 *  4. Follow callback → Pomerium: exchanges code, sets session cookie, redirects
 *     to the original workspace URL.
 *  5. GET ws-alice.devbox.localhost with session cookie → Pomerium proxies to
 *     workspace-upstream (traefik/whoami) → 200 with X-Pomerium-Jwt-Assertion.
 *
 * Per §6.8: only the sim base URLs differ from a real-cloud deployment; this
 * flow is identical with real Entra (the same OIDC discovery → code → token
 * sequence, just against microsoftonline.com).
 */

const WORKSPACE_HOST = `ws-alice.${ROUTE_DOMAIN}`;
// azure-sim port exposed on the host (docker-compose.e2e.yml: "4568:4568").
const AZURE_SIM_PORT = 4568;

// Maximum redirects before we give up (Pomerium auth flow uses ~5 hops).
const MAX_HOPS = 12;

interface Hop {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  cookies: Map<string, string>; // name → value
}

/** Parse Set-Cookie headers into name→value pairs (attributes dropped). */
function parseSetCookies(setCookies: string | string[] | undefined): Map<string, string> {
  const fresh = new Map<string, string>();
  if (setCookies) {
    for (const sc of Array.isArray(setCookies) ? setCookies : [setCookies]) {
      const part = sc.split(";")[0] ?? "";
      const eq = part.indexOf("=");
      if (eq > 0) fresh.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }
  return fresh;
}

/** One request to the Pomerium TLS listener with the jar's cookies attached. */
async function proxyRequest(url: URL, cookieJar: Map<string, string>): Promise<Hop> {
  const cookies = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await pomeriumRequest(url, cookies ? { Cookie: cookies } : {});
  return { ...res, cookies: parseSetCookies(res.headers["set-cookie"]) };
}

/**
 * Follow the OIDC redirect chain, maintaining a shared cookie jar. Pomerium
 * hosts (*.devbox.localhost) are reached through the TLS listener; redirects to
 * the azure-sim (its compose-internal hostname/port) are followed directly over
 * its published plain-HTTP port. Returns the final hop AND the accumulated jar
 * so callers can assert on both the response and the cookies the flow set.
 */
async function authedGet(startHost: string): Promise<{ hop: Hop; cookieJar: Map<string, string> }> {
  const cookieJar = new Map<string, string>();
  let currentUrl = new URL(`https://${startHost}/`);
  let hop: Hop | undefined;

  for (let i = 0; i < MAX_HOPS; i++) {
    hop = await proxyRequest(currentUrl, cookieJar);

    // Merge Set-Cookie into the jar.
    for (const [k, v] of hop.cookies) cookieJar.set(k, v);

    if (hop.status < 300 || hop.status >= 400) break;

    const location = hop.headers.location;
    if (!location) throw new Error(`redirect without Location at hop ${i.toString()}`);
    const rawLoc = Array.isArray(location) ? location[0] : location;
    const next = new URL(rawLoc ?? "", currentUrl);

    // If the redirect target is the azure-sim (port 4568 or hostname azure-sim),
    // follow it directly — the discovery document uses `azure-sim:4568` internally
    // but that host is exposed on the host at 127.0.0.1:4568. The azure-sim
    // immediately redirects back to the Pomerium callback.
    if (parseInt(next.port) === AZURE_SIM_PORT || next.hostname === "azure-sim") {
      const azureHop = await followAzureSim(next, cookieJar);
      for (const [k, v] of azureHop.cookies) cookieJar.set(k, v);
      if (azureHop.status >= 300 && azureHop.status < 400) {
        const loc2 = azureHop.headers.location;
        const raw2 = Array.isArray(loc2) ? loc2[0] : loc2;
        if (raw2) {
          currentUrl = new URL(raw2, next);
          continue;
        }
      }
      hop = azureHop;
      break;
    }

    currentUrl = next;
  }

  if (!hop) throw new Error("authedGet: no response after redirect chain");
  return { hop, cookieJar };
}

/** Direct request to the azure-sim (at 127.0.0.1:AZURE_SIM_PORT); not via the proxy.
 * The azure-sim hostname `azure-sim` is resolved to 127.0.0.1 since it is
 * only routable inside the Docker network, but its port is exposed on the host. */
function followAzureSim(url: URL, cookieJar: Map<string, string>): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const cookies = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const hostHeader = url.hostname;
    const resolvedHost = url.hostname === "azure-sim" ? "127.0.0.1" : url.hostname;
    const port = url.port ? parseInt(url.port) : AZURE_SIM_PORT;
    const options = {
      host: resolvedHost,
      port,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        Host: hostHeader,
        ...(cookies ? { Cookie: cookies } : {}),
      },
    };
    const req = httpRequest(options, (res: IncomingMessage) => {
      collectResponse(res, (r: ProxyResponse) => {
        resolve({ ...r, cookies: parseSetCookies(r.headers["set-cookie"]) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

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
