// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { tallyWorkspaceStates } from "./stats";

describe("tallyWorkspaceStates", () => {
  it("counts an empty fleet as zero across all states", () => {
    const stats = tallyWorkspaceStates([]);
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.byState.running).toBe(0);
    expect(stats.byState.stopped).toBe(0);
  });

  it("tallies per state and counts running+idle as active", () => {
    const stats = tallyWorkspaceStates(["running", "running", "idle", "stopped", "error"]);
    expect(stats.total).toBe(5);
    expect(stats.byState.running).toBe(2);
    expect(stats.byState.idle).toBe(1);
    expect(stats.byState.stopped).toBe(1);
    expect(stats.byState.error).toBe(1);
    expect(stats.active).toBe(3);
  });
});
