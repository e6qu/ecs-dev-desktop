// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, request as httpRequest, type ClientRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { POMERIUM_ASSERTION_HEADER } from "@edd/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGate } from "./gate";

/**
 * Component test for the workspace gate (PEP): given a (faked) PDP verdict, it
 * forwards allowed HTTP/WS traffic to the upstream and refuses everything else.
 */

const UPSTREAM_BODY = "hello-from-upstream";

let upstream: Server;
let gate: Server;
let gatePort: number;
/** Mutable PDP verdict the injected fetch returns; set per test. */
let verdict: number;
let pdpThrows = false;

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "x-echo-path": req.url ?? "" });
    res.end(UPSTREAM_BODY);
  });
  upstream.on("upgrade", (_req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
    );
    socket.on("data", (d: Buffer) => socket.write(d)); // echo
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const fakeFetch: typeof fetch = () => {
    if (pdpThrows) return Promise.reject(new Error("pdp down"));
    return Promise.resolve(new Response(null, { status: verdict }));
  };

  gate = createGate({
    pdpUrl: "http://pdp.invalid/api/internal/authz",
    upstreamUrl: `http://127.0.0.1:${String(port(upstream))}`,
    fetchImpl: fakeFetch,
  });
  await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
  gatePort = port(gate);
});

afterAll(() => {
  // Force-drop any lingering tunneled sockets and stop listening. Done
  // synchronously: awaiting close() can hang on an upgraded (WebSocket) socket.
  gate.closeAllConnections();
  upstream.closeAllConnections();
  gate.close();
  upstream.close();
});

interface HttpResult {
  status: number;
  body: string;
}

function gateGet(withToken: boolean, path = "/"): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: "ws-abc.devbox.localhost" };
    if (withToken) headers[POMERIUM_ASSERTION_HEADER] = "a-token";
    const req = httpRequest({ port: gatePort, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += String(c)));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** A started WebSocket-upgrade request to the gate carrying a valid assertion;
 * each test attaches its own upgrade/response handlers. */
function wsUpgradeRequest(): ClientRequest {
  return httpRequest({
    port: gatePort,
    path: "/ws",
    headers: {
      host: "ws-abc.devbox.localhost",
      connection: "Upgrade",
      upgrade: "websocket",
      [POMERIUM_ASSERTION_HEADER]: "a-token",
    },
  });
}

describe("workspace gate", () => {
  it("forwards an allowed request to the upstream (PDP 204)", async () => {
    verdict = 204;
    pdpThrows = false;
    const res = await gateGet(true, "/code/path");
    expect(res.status).toBe(200);
    expect(res.body).toBe(UPSTREAM_BODY);
  });

  it("refuses a denied request without reaching the upstream (PDP 403)", async () => {
    verdict = 403;
    pdpThrows = false;
    const res = await gateGet(true);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain(UPSTREAM_BODY);
  });

  it("returns 401 when the identity assertion is absent (no PDP call)", async () => {
    verdict = 204; // even if the PDP would allow, a missing assertion is 401
    pdpThrows = false;
    const res = await gateGet(false);
    expect(res.status).toBe(401);
  });

  it("fails closed with 502 when the PDP is unreachable", async () => {
    pdpThrows = true;
    const res = await gateGet(true);
    expect(res.status).toBe(502);
    expect(res.body).not.toContain(UPSTREAM_BODY);
  });

  it("tunnels an allowed WebSocket upgrade and echoes (PDP 204)", async () => {
    verdict = 204;
    pdpThrows = false;
    const echoed = await new Promise<string>((resolve, reject) => {
      const req = wsUpgradeRequest();
      req.on("upgrade", (_res, socket) => {
        socket.write("ping");
        socket.once("data", (d: Buffer) => {
          socket.destroy();
          resolve(d.toString());
        });
      });
      req.on("response", (res) => {
        reject(new Error(`expected upgrade, got ${String(res.statusCode)}`));
      });
      req.on("error", reject);
      req.end();
    });
    expect(echoed).toContain("ping");
  });

  it("refuses a denied WebSocket upgrade (PDP 403)", async () => {
    verdict = 403;
    pdpThrows = false;
    const status = await new Promise<number>((resolve, reject) => {
      const req = wsUpgradeRequest();
      req.on("upgrade", () => {
        reject(new Error("upgrade should have been refused"));
      });
      req.on("response", (res) => {
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe("workspace gate (dynamic upstream resolver)", () => {
  let dynGate: Server;
  let dynPort: number;
  let resolverThrows = false;

  beforeAll(async () => {
    dynGate = createGate({
      pdpUrl: "http://pdp.invalid/api/internal/authz",
      fetchImpl: () => Promise.resolve(new Response(null, { status: 204 })), // PDP allows
      resolveUpstream: () => {
        if (resolverThrows) return Promise.reject(new Error("wake/connect-info failed"));
        return Promise.resolve(`http://127.0.0.1:${String(port(upstream))}`);
      },
    });
    await new Promise<void>((resolve) => dynGate.listen(0, "127.0.0.1", resolve));
    dynPort = port(dynGate);
  });

  afterAll(() => {
    dynGate.closeAllConnections();
    dynGate.close();
  });

  function dynGet(): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          port: dynPort,
          path: "/",
          headers: { host: "ws-abc.devbox.localhost", [POMERIUM_ASSERTION_HEADER]: "a-token" },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += String(c)));
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("forwards an authorized request to the per-request resolved upstream", async () => {
    resolverThrows = false;
    const res = await dynGet();
    expect(res.status).toBe(200);
    expect(res.body).toBe(UPSTREAM_BODY);
  });

  it("fails closed with 502 when the resolver (wake/connect-info) throws", async () => {
    resolverThrows = true;
    const res = await dynGet();
    expect(res.status).toBe(502);
    expect(res.body).not.toContain(UPSTREAM_BODY);
  });
});
