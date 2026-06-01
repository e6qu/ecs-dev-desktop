// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  can,
  InvalidTransitionError,
  transition,
  type WorkspaceState,
} from "./workspace-state-machine";

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
});
