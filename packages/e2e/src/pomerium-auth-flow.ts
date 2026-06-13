// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared driver for the Pomerium authenticated OIDC flow against the azure-sim.
// The sim's /authorize redirects straight back with a code (no interactive page),
// so a plain redirect-following HTTP client with a cookie jar completes the whole
// chain: workspace host → Pomerium sign_in → azure-sim → Pomerium callback →
// session cookie → upstream with X-Pomerium-Jwt-Assertion. Used by the Pomerium
// proxy-pass e2e and the per-workspace authz e2e (so both share one flow).
import { request as httpRequest, type IncomingMessage } from "node:http";
import { URL } from "node:url";

import { collectResponse, pomeriumRequest, type ProxyResponse } from "./pomerium-proxy";

export { pomeriumRequest, ROUTE_DOMAIN } from "./pomerium-proxy";

// azure-sim port exposed on the host (docker-compose.e2e.yml: "4568:4568").
const AZURE_SIM_PORT = 4568;
// Maximum redirects before we give up (Pomerium auth flow uses ~5 hops).
const MAX_HOPS = 12;

export interface Hop {
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

/** Direct request to the azure-sim (its compose-internal host resolves to
 * loopback, but its port is published). Used for the IdP hop in the chain. */
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
      headers: { Host: hostHeader, ...(cookies ? { Cookie: cookies } : {}) },
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

/**
 * Follow the OIDC redirect chain, maintaining a shared cookie jar, and return
 * the final hop plus the accumulated jar. Pomerium hosts go through the TLS
 * listener; azure-sim hops are followed directly over its published port.
 */
export async function authedGet(
  startHost: string,
): Promise<{ hop: Hop; cookieJar: Map<string, string> }> {
  const cookieJar = new Map<string, string>();
  let currentUrl = new URL(`https://${startHost}/`);
  let hop: Hop | undefined;

  for (let i = 0; i < MAX_HOPS; i++) {
    hop = await proxyRequest(currentUrl, cookieJar);
    for (const [k, v] of hop.cookies) cookieJar.set(k, v);
    if (hop.status < 300 || hop.status >= 400) break;

    const location = hop.headers.location;
    if (!location) throw new Error(`redirect without Location at hop ${i.toString()}`);
    const rawLoc = Array.isArray(location) ? location[0] : location;
    const next = new URL(rawLoc ?? "", currentUrl);

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

/** Extract the value of the `X-Pomerium-Jwt-Assertion` header that the whoami
 * upstream echoes into its body (the assertion Pomerium injected). */
export function assertionFromEcho(body: string): string | undefined {
  const m = /x-pomerium-jwt-assertion:\s*(\S+)/i.exec(body);
  return m?.[1];
}
