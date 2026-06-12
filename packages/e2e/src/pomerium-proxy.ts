// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared transport for the Pomerium e2e suites: the proxy serves real TLS
// (Pomerium forces the https scheme in every absolute URL it builds), so
// requests go over HTTPS to the published harness port with the sim CA
// trusted explicitly (scripts/gen-sim-tls-cert.sh; *.devbox.localhost SANs) —
// no disabled verification. SNI (`servername`) carries the virtual host while
// the TCP connection targets loopback.
import { readFileSync } from "node:fs";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { URL } from "node:url";

const POMERIUM_HOST = "127.0.0.1";
export const POMERIUM_PORT = 8443;
export const ROUTE_DOMAIN = "devbox.localhost";

const CA_PATH = join(import.meta.dirname, "../../../temp/sim-tls/ca.pem");

/** The harness CA (fail loudly with the fix if the cert was never generated). */
function simTlsCa(): Buffer {
  try {
    return readFileSync(CA_PATH);
  } catch {
    throw new Error(`missing ${CA_PATH} — run: sh scripts/gen-sim-tls-cert.sh`);
  }
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Collect an HTTP response's body + lower-cased headers into a ProxyResponse. */
export function collectResponse(res: IncomingMessage, resolve: (r: ProxyResponse) => void): void {
  let body = "";
  res.on("data", (c: Buffer) => {
    body += c.toString();
  });
  res.on("end", () => {
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
    resolve({ status: res.statusCode ?? 0, headers, body });
  });
}

/**
 * One HTTPS request to the Pomerium harness listener. The URL's host is the
 * virtual host (Host header + SNI); the connection goes to loopback:8443.
 */
export function pomeriumRequest(
  url: URL,
  extraHeaders: Record<string, string> = {},
  method = "GET",
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      host: POMERIUM_HOST,
      port: POMERIUM_PORT,
      path: url.pathname + url.search,
      method,
      ca: simTlsCa(),
      servername: url.hostname,
      headers: {
        Host: url.hostname + (url.port ? `:${url.port}` : ""),
        ...extraHeaders,
      },
    };
    const req = httpsRequest(options, (res: IncomingMessage) => {
      collectResponse(res, resolve);
    });
    req.on("error", reject);
    req.end();
  });
}
