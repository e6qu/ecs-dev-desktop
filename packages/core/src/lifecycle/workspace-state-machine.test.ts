// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { ok } from "../result";
import {
  can,
  transition,
  workspaceActions,
  type WorkspaceEvent,
  type WorkspaceState,
} from "./workspace-state-machine";

const STATES: WorkspaceState[] = [
  "provisioning",
  "running",
  "idle",
  "stopped",
  "terminated",
  "error",
];
const EVENTS: WorkspaceEvent[] = [
  "provisioned",
  "activity",
  "idleTimeout",
  "stop",
  "wake",
  "terminate",
  "fail",
];
// The complete set of permitted (state, event) pairs — pinned here so any change
// to the transition table is caught by the exhaustive test below.
const PERMITTED = new Set<string>([
  "provisioning:provisioned",
  "provisioning:stop",
  "provisioning:fail",
  "provisioning:terminate",
  "running:idleTimeout",
  "running:stop",
  "running:fail",
  "running:terminate",
  "idle:activity",
  "idle:stop",
  "idle:fail",
  "idle:terminate",
  "stopped:wake",
  "stopped:terminate",
  "stopped:fail",
  "error:terminate",
]);

describe("workspace state machine", () => {
  it("runs the full scale-to-zero loop", () => {
    expect(transition("provisioning", "provisioned")).toEqual(ok("running"));
    expect(transition("running", "idleTimeout")).toEqual(ok("idle"));
    expect(transition("idle", "stop")).toEqual(ok("stopped"));
    expect(transition("stopped", "wake")).toEqual(ok("provisioning"));
  });

  it("wakes from idle on activity", () => {
    expect(transition("idle", "activity")).toEqual(ok("running"));
  });

  it("cancels an in-flight wake back to stopped", () => {
    expect(transition("provisioning", "stop")).toEqual(ok("stopped"));
  });

  it("is terminal once terminated", () => {
    expect(can("terminated", "wake")).toBe(false);
    expect(transition("terminated", "wake").ok).toBe(false);
  });

  it("returns a conflict domain error for a nonsensical transition", () => {
    const result = transition("stopped", "activity");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("permits exactly the defined transitions and rejects every other pair", () => {
    for (const state of STATES) {
      for (const event of EVENTS) {
        const permitted = PERMITTED.has(`${state}:${event}`);
        expect(can(state, event)).toBe(permitted);
        expect(transition(state, event).ok).toBe(permitted);
      }
    }
  });

  it("leaves terminated with no outgoing transitions", () => {
    for (const event of EVENTS) expect(can("terminated", event)).toBe(false);
  });
});

describe("workspaceActions", () => {
  it("offers snapshot/stop/delete while running or idle", () => {
    expect(workspaceActions("running")).toEqual(["snapshot", "stop", "delete"]);
    expect(workspaceActions("idle")).toEqual(["snapshot", "stop", "delete"]);
  });
  it("offers start/delete while stopped", () => {
    expect(workspaceActions("stopped")).toEqual(["start", "delete"]);
  });
  it("offers cancelStop + delete while stopping (a manual stop can be canceled)", () => {
    expect(workspaceActions("stopping")).toEqual(["cancelStop", "delete"]);
  });
  it("offers delete from provisioning; retry + delete from error (relaunch or abandon)", () => {
    expect(workspaceActions("provisioning")).toEqual(["delete"]);
    expect(workspaceActions("error")).toEqual(["retry", "delete"]);
  });
  it("offers no actions while deleting (teardown in progress)", () => {
    expect(workspaceActions("deleting")).toEqual([]);
  });
  it("offers only undelete once terminated (restorable until the retention purge)", () => {
    expect(workspaceActions("terminated")).toEqual(["undelete"]);
  });
});
