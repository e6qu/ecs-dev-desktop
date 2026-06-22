// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based tests (fast-check) for tallyWorkspaceStates. Conservation is the
// headline: total === input.length === sum over byState, and active === running + idle.
// Also order-independent (a permutation of the same states tallies identically).
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { WorkspaceState } from "../lifecycle/workspace-state-machine";
import { tallyWorkspaceStates } from "./stats";

const ALL_STATES: readonly WorkspaceState[] = [
  "provisioning",
  "running",
  "idle",
  "stopped",
  "deleting",
  "terminated",
  "error",
];
const stateArb = fc.constantFrom(...ALL_STATES);
const statesArb = fc.array(stateArb, { maxLength: 40 });

const sumByState = (byState: Record<WorkspaceState, number>): number =>
  ALL_STATES.reduce((acc, s) => acc + byState[s], 0);

describe("tallyWorkspaceStates — properties", () => {
  it("conserves: total === input length === sum(byState); active === running + idle", () => {
    fc.assert(
      fc.property(statesArb, (states) => {
        const stats = tallyWorkspaceStates(states);
        expect(stats.total).toBe(states.length);
        expect(sumByState(stats.byState)).toBe(states.length);
        expect(stats.active).toBe(stats.byState.running + stats.byState.idle);
        // Every per-state count is non-negative and the manual count matches.
        for (const s of ALL_STATES) {
          expect(stats.byState[s]).toBe(states.filter((x) => x === s).length);
          expect(stats.byState[s]).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it("is order-independent on a permutation of the same states", () => {
    const permutedArb = statesArb.chain((states) =>
      fc
        .shuffledSubarray(
          states.map((_, i) => i),
          { minLength: states.length, maxLength: states.length },
        )
        .map((order) => ({
          states,
          permuted: order.map((i) => states[i]).filter((s): s is WorkspaceState => s !== undefined),
        })),
    );
    fc.assert(
      fc.property(permutedArb, ({ states, permuted }) => {
        const a = tallyWorkspaceStates(states);
        const b = tallyWorkspaceStates(permuted);
        expect(b.total).toBe(a.total);
        expect(b.active).toBe(a.active);
        expect(b.byState).toEqual(a.byState);
      }),
    );
  });

  it("empty input → all zeros", () => {
    const stats = tallyWorkspaceStates([]);
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
    expect(sumByState(stats.byState)).toBe(0);
  });
});
