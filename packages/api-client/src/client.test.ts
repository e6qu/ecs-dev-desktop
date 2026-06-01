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
});
