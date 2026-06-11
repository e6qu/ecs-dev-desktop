// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/healthz", () => {
  it("responds 200 with the web liveness payload", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "web" });
  });
});
