// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { planConnect } from "./connect";

describe("planConnect", () => {
  it("connects directly to a reachable workspace", () => {
    expect(planConnect("running")).toBe("ready");
    expect(planConnect("idle")).toBe("ready");
  });

  it("wakes a scaled-to-zero workspace", () => {
    expect(planConnect("stopped")).toBe("wake");
  });

  it("waits when a wake is already in flight", () => {
    expect(planConnect("provisioning")).toBe("pending");
  });

  it("refuses a terminal or failed workspace", () => {
    expect(planConnect("terminated")).toBe("unavailable");
    expect(planConnect("error")).toBe("unavailable");
  });
});
