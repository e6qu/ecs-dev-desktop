// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { gatewayToken, makeUpstreamResolver } from "./upstream-resolver";

const SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const CP = "http://cp.internal:3000";
const BASE = "devbox.localhost";

interface Call {
  url: string;
  method: string;
  auth: string | null;
}

function recordingFetch(connectInfo: { status: number; body?: unknown }): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const headers = new Headers(init?.headers);
    calls.push({ url: u, method: init?.method ?? "GET", auth: headers.get("authorization") });
    if (u.includes("/connect-info")) {
      return Promise.resolve(
        new Response(connectInfo.body === undefined ? null : JSON.stringify(connectInfo.body), {
          status: connectInfo.status,
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 204 })); // /connect (wake)
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("makeUpstreamResolver", () => {
  it("wakes the workspace then resolves its live OpenVSCode address", async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      body: { host: "10.71.1.5", port: 3000 },
    });
    const resolve = makeUpstreamResolver({
      controlPlaneUrl: CP,
      gatewaySecretHex: SECRET,
      baseDomain: BASE,
      fetchImpl: fetch,
    });

    const upstream = await resolve("ws-abc.devbox.localhost");
    expect(upstream).toBe("http://10.71.1.5:3000");

    // POST /connect (wake) then GET /connect-info?protocol=http, both with the
    // per-workspace gateway bearer.
    const expectedToken = gatewayToken(SECRET, "ws-abc");
    expect(calls[0]?.url).toBe(`${CP}/api/workspaces/ws-abc/connect`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.auth).toBe(`Bearer ${expectedToken}`);
    expect(calls[1]?.url).toBe(`${CP}/api/workspaces/ws-abc/connect-info?protocol=http`);
    expect(calls[1]?.auth).toBe(`Bearer ${expectedToken}`);
  });

  it("rejects a host that is not a workspace subdomain", async () => {
    const { fetch } = recordingFetch({ status: 200, body: { host: "x", port: 3000 } });
    const resolve = makeUpstreamResolver({
      controlPlaneUrl: CP,
      gatewaySecretHex: SECRET,
      baseDomain: BASE,
      fetchImpl: fetch,
    });
    await expect(resolve("health.devbox.localhost")).rejects.toThrow();
    await expect(resolve("ws-abc.evil.example")).rejects.toThrow();
  });

  it("throws when connect-info fails (gate then fails closed → 502)", async () => {
    const { fetch } = recordingFetch({ status: 409 });
    const resolve = makeUpstreamResolver({
      controlPlaneUrl: CP,
      gatewaySecretHex: SECRET,
      baseDomain: BASE,
      fetchImpl: fetch,
    });
    await expect(resolve("ws-abc.devbox.localhost")).rejects.toThrow(/connect-info/);
  });

  it("derives a per-workspace token (different per workspace id)", () => {
    expect(gatewayToken(SECRET, "ws-a")).not.toBe(gatewayToken(SECRET, "ws-b"));
  });
});
