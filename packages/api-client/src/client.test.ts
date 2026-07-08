// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { ApiClient, ApiError } from "./index";

describe("ApiClient", () => {
  it("parses a successful listWorkspaces response", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ workspaces: [] }), { status: 200 }));

    const client = new ApiClient({ baseUrl: "http://x/", fetch: fetchImpl });
    const res = await client.listWorkspaces();
    expect(res.workspaces).toEqual([]);
  });

  it("fails loudly when an error response violates the { error } contract", async () => {
    // No fallback: a non-conformant error body is a bug, so the strict parse throws.
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ message: "oops" }), { status: 500 }));

    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchImpl });
    await expect(client.listWorkspaces()).rejects.toThrow();
  });

  it("surfaces the server's error message and status on a domain failure", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "workspace quota reached (5)" }), { status: 409 }),
      );

    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const thrown: unknown = await client
      .createWorkspace({ baseImage: "img" })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ApiError);
    if (thrown instanceof ApiError) {
      expect(thrown.message).toBe("workspace quota reached (5)");
      expect(thrown.status).toBe(409);
    }
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
            resources: { cpuUnits: 512, memoryMiB: 2048, volumeGiB: 8 },
            state: "stopped",
            createdAt: "2026-06-01T00:00:00.000Z",
            availableActions: ["start", "delete"],
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
