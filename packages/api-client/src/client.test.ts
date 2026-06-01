// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { ApiClient } from "./index";

describe("ApiClient", () => {
  it("parses a successful listWorkspaces response", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ workspaces: [] }), { status: 200 }));

    const client = new ApiClient({ baseUrl: "http://x/", fetch: fetchImpl });
    const res = await client.listWorkspaces();
    expect(res.workspaces).toEqual([]);
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response("nope", { status: 500 }));

    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchImpl });
    await expect(client.listWorkspaces()).rejects.toThrow(/500/);
  });

  it("POSTs to the stop endpoint for a workspace", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, method: init?.method ?? "GET" });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "ws-1",
            ownerId: "alice",
            baseImage: "img",
            state: "stopped",
            createdAt: "2026-06-01T00:00:00.000Z",
          }),
          { status: 200 },
        ),
      );
    };

    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const ws = await client.stopWorkspace("ws-1");
    expect(ws.state).toBe("stopped");
    expect(calls).toEqual([{ url: "http://x/api/workspaces/ws-1/stop", method: "POST" }]);
  });
});
