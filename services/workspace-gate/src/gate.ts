// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import { POMERIUM_ASSERTION_HEADER, WORKSPACE_HOST_HEADER } from "@edd/config";

/**
 * Workspace authorization gate (PEP) for the identity-aware proxy (DO_NEXT #5).
 *
 * It sits between Pomerium and a workspace's HTTP/WebSocket upstream (OpenVSCode
 * Server). Pomerium authenticates the user and injects the signed identity
 * assertion; the gate forwards that assertion plus the workspace host to the
 * control-plane decision point (PDP, `/api/internal/authz`) and only proxies the
 * request to the upstream when the PDP allows it. Pomerium itself can't make the
 * decision — per-workspace ownership lives in DynamoDB, not in any token claim.
 *
 * Both ordinary HTTP requests and WebSocket upgrades are authorized; the upgrade
 * handshake carries the same assertion, so a connection is gated before any
 * bytes are tunneled.
 */

export interface GateOptions {
  /** PDP endpoint (the control-plane `/api/internal/authz` URL). */
  readonly pdpUrl: string;
  /** Static workspace HTTP/WS upstream. Used when `resolveUpstream` is absent
   * (single fixed workspace / tests). */
  readonly upstreamUrl?: string;
  /** Per-request dynamic upstream resolver, given the request Host. The
   * production path uses this to wake the workspace and resolve its live ENI
   * address via the control-plane connect-info — so one gate fronts every
   * workspace (Pomerium's static upstream) and routes each by subdomain. Throws
   * to fail closed (the gate returns 502). Takes precedence over `upstreamUrl`. */
  readonly resolveUpstream?: (host: string) => Promise<string>;
  /** Injectable fetch (tests); defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Pull a single header value (Node lower-cases header names). */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Ask the PDP whether this request may proceed. Returns the PDP's HTTP status
 * (204 = allow). Missing host/assertion is a 401 without a round-trip; a PDP
 * that is unreachable maps to 502 — both fail closed (the caller does not
 * forward).
 */
async function authorize(
  opts: GateOptions,
  host: string | undefined,
  token: string | undefined,
): Promise<number> {
  if (host === undefined || host.length === 0 || token === undefined || token.length === 0) {
    return 401;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(opts.pdpUrl, {
      method: "GET",
      headers: { [WORKSPACE_HOST_HEADER]: host, [POMERIUM_ASSERTION_HEADER]: token },
    });
    return res.status;
  } catch {
    return 502;
  }
}

/** Map a PDP status to the status the gate returns when it refuses to forward. */
function denyStatus(pdpStatus: number): number {
  if (pdpStatus === 401) return 401;
  if (pdpStatus === 403) return 403;
  return 502; // PDP error/unexpected → bad gateway (still denies access).
}

function isAllowed(pdpStatus: number): boolean {
  return pdpStatus >= 200 && pdpStatus < 300;
}

function refuse(res: ServerResponse, status: number): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: status === 401 ? "unauthorized" : "forbidden" }));
}

/** http.request options that forward `req` to the workspace `upstream` verbatim
 * (only the Host header is rewritten to the upstream). Shared by the HTTP and
 * WebSocket-upgrade paths. */
function upstreamOptions(upstream: URL, req: IncomingMessage): RequestOptions {
  return {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: upstream.host },
  };
}

/** Forward an authorized ordinary HTTP request to the upstream, streaming both ways. */
function proxyHttp(upstream: URL, req: IncomingMessage, res: ServerResponse): void {
  const proxyReq = httpRequest(upstreamOptions(upstream, req), (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  // If the client goes away mid-exchange, abort the upstream request so its socket
  // doesn't linger (a no-op once the response has already completed normally).
  res.on("close", () => {
    proxyReq.destroy();
  });
  req.pipe(proxyReq);
}

/** Forward an authorized WebSocket upgrade and tunnel the two sockets together. */
function proxyUpgrade(
  upstream: URL,
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
): void {
  const proxyReq = httpRequest(upstreamOptions(upstream, req));
  proxyReq.on("upgrade", (proxyRes, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/1.1 ${String(proxyRes.statusCode ?? 101)} ${proxyRes.statusMessage ?? "Switching Protocols"}`;
    const headerLines = Object.entries(proxyRes.headers).map(
      ([k, val]) => `${k}: ${Array.isArray(val) ? val.join(", ") : (val ?? "")}`,
    );
    clientSocket.write([statusLine, ...headerLines, "", ""].join("\r\n"));
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
    // Tear down both halves when either ends or errors, so neither socket leaks.
    const teardown = (): void => {
      upstreamSocket.destroy();
      clientSocket.destroy();
    };
    upstreamSocket.on("error", teardown);
    upstreamSocket.on("close", teardown);
    clientSocket.on("error", teardown);
    clientSocket.on("close", teardown);
  });
  // The upstream answered WITHOUT upgrading (e.g. a just-woken workspace whose
  // editor isn't serving WebSocket yet returns an error/redirect). Relay the status
  // and close the client socket — otherwise it hangs open until the client times
  // out, leaking a socket per such connection.
  proxyReq.on("response", (proxyRes) => {
    const reason = proxyRes.statusMessage ?? "";
    clientSocket.write(
      `HTTP/1.1 ${String(proxyRes.statusCode ?? 502)} ${reason}\r\nconnection: close\r\n\r\n`,
    );
    clientSocket.destroy();
    proxyRes.destroy();
  });
  proxyReq.on("error", () => clientSocket.destroy());
  if (head.length > 0) proxyReq.write(head);
  proxyReq.end();
}

/** Resolve the upstream for a request Host: the dynamic resolver (wake + live
 * ENI via connect-info) when configured, else the static upstream. Throws if
 * neither is configured or resolution fails (caller fails closed → 502). */
async function resolveUpstream(opts: GateOptions, host: string | undefined): Promise<URL> {
  if (opts.resolveUpstream !== undefined) return new URL(await opts.resolveUpstream(host ?? ""));
  if (opts.upstreamUrl !== undefined) return new URL(opts.upstreamUrl);
  throw new Error("workspace-gate: no upstream configured (set upstreamUrl or resolveUpstream)");
}

/**
 * Build the gate HTTP server. Call `.listen(port)` to start it. Each request
 * (and WebSocket upgrade) is authorized via the PDP, then forwarded to the
 * workspace upstream (resolved/woken per request when `resolveUpstream` is set).
 */
export function createGate(opts: GateOptions): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const status = await authorize(
        opts,
        req.headers.host,
        headerValue(req, POMERIUM_ASSERTION_HEADER),
      );
      if (!isAllowed(status)) {
        refuse(res, denyStatus(status));
        return;
      }
      let upstream: URL;
      try {
        upstream = await resolveUpstream(opts, req.headers.host);
      } catch {
        refuse(res, 502);
        return;
      }
      proxyHttp(upstream, req, res);
    })();
  });

  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      const status = await authorize(
        opts,
        req.headers.host,
        headerValue(req, POMERIUM_ASSERTION_HEADER),
      );
      if (!isAllowed(status)) {
        socket.write(
          `HTTP/1.1 ${String(denyStatus(status))} Forbidden\r\nconnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      let upstream: URL;
      try {
        upstream = await resolveUpstream(opts, req.headers.host);
      } catch {
        socket.write("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      proxyUpgrade(upstream, req, socket, head);
    })();
  });

  return server;
}
