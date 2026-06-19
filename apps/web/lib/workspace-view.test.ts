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
  it("offers delete from provisioning/error (recoverable or abandonable)", () => {
    expect(availableActions("provisioning")).toEqual(["delete"]);
    expect(availableActions("error")).toEqual(["delete"]);
  });
  it("offers no actions while deleting/terminated (already torn down)", () => {
    expect(availableActions("deleting")).toEqual([]);
    expect(availableActions("terminated")).toEqual([]);
  });
});
