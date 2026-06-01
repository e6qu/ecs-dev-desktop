// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { availableActions, statusMeta } from "./workspace-view";

describe("statusMeta", () => {
  it("pulses for live states", () => {
    expect(statusMeta("running").pulse).toBe(true);
    expect(statusMeta("stopped").pulse).toBe(false);
  });
});

describe("availableActions", () => {
  it("offers snapshot/stop/delete while running", () => {
    expect(availableActions("running")).toEqual(["snapshot", "stop", "delete"]);
  });
  it("offers start/delete while stopped", () => {
    expect(availableActions("stopped")).toEqual(["start", "delete"]);
  });
  it("offers only delete while terminated", () => {
    expect(availableActions("terminated")).toEqual(["delete"]);
  });
});
