// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeAll, describe, expect, it } from "vitest";

import { GET, POST } from "./route";

const url = "http://localhost/api/workspaces";

beforeAll(() => {
  process.env.EDD_DEV_AUTH = "1";
});

describe("workspaces route — auth (no DB)", () => {
  it("returns 401 without credentials", async () => {
    const res = await GET(new Request(url));
    expect(res.status).toBe(401);
  });

  it("returns 403 when a viewer tries to create", async () => {
    const res = await POST(
      new Request(url, {
        method: "POST",
        headers: {
          "x-edd-user-id": "v1",
          "x-edd-role": "viewer",
          "content-type": "application/json",
        },
        body: JSON.stringify({ baseImage: "img" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
