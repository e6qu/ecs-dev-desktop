// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  can,
  InvalidTransitionError,
  transition,
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
    let s: WorkspaceState = "provisioning";
    s = transition(s, "provisioned");
    expect(s).toBe("running");
    s = transition(s, "idleTimeout");
    expect(s).toBe("idle");
    s = transition(s, "stop");
    expect(s).toBe("stopped");
    s = transition(s, "wake");
    expect(s).toBe("provisioning");
    s = transition(s, "provisioned");
    expect(s).toBe("running");
  });

  it("wakes from idle on activity", () => {
    expect(transition("idle", "activity")).toBe("running");
  });

  it("is terminal once terminated", () => {
    expect(can("terminated", "wake")).toBe(false);
    expect(() => transition("terminated", "wake")).toThrow(InvalidTransitionError);
  });

  it("rejects nonsensical transitions", () => {
    expect(() => transition("stopped", "activity")).toThrow(InvalidTransitionError);
  });

  it("permits exactly the defined transitions and rejects every other pair", () => {
    for (const state of STATES) {
      for (const event of EVENTS) {
        if (PERMITTED.has(`${state}:${event}`)) {
          expect(can(state, event)).toBe(true);
          expect(() => transition(state, event)).not.toThrow();
        } else {
          expect(can(state, event)).toBe(false);
          expect(() => transition(state, event)).toThrow(InvalidTransitionError);
        }
      }
    }
  });

  it("leaves terminated with no outgoing transitions", () => {
    for (const event of EVENTS) expect(can("terminated", event)).toBe(false);
  });
});
