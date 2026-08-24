// SPDX-License-Identifier: AGPL-3.0-or-later
// selectIdle drives scale-to-zero — the property that matters is it idles EXACTLY the aged set and
// fails safe on a malformed timestamp (never idling, or mass-idling, the wrong workspaces).
import { isoTimestamp, workspaceId } from "@edd/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { selectIdle, type ActiveWorkspace } from "./index";

const NOW_MS = Date.parse("2026-06-01T00:00:00.000Z");
const NOW = isoTimestamp(new Date(NOW_MS).toISOString());

const activeArb = fc
  .array(fc.integer({ min: 0, max: 30 * 86_400_000 }), { maxLength: 20 })
  .map((ages) => ({
    active: ages.map(
      (ageMs, i): ActiveWorkspace => ({
        id: workspaceId(`ws-${String(i)}`),
        lastActivity: isoTimestamp(new Date(NOW_MS - ageMs).toISOString()),
      }),
    ),
    ages,
  }));

describe("selectIdle (fuzz)", () => {
  it("selects exactly the workspaces idle >= threshold (inclusive boundary)", () => {
    fc.assert(
      fc.property(
        activeArb,
        fc.integer({ min: 0, max: 30 * 86_400_000 }),
        ({ active, ages }, threshold) => {
          const expected = active.filter((_, i) => (ages[i] ?? 0) >= threshold).map((w) => w.id);
          expect(selectIdle(active, NOW, threshold)).toEqual(expected);
        },
      ),
    );
  });

  it("is monotonic in the threshold — a larger window selects a subset", () => {
    fc.assert(
      fc.property(
        activeArb,
        fc.integer({ min: 0, max: 15 * 86_400_000 }),
        fc.integer({ min: 0, max: 15 * 86_400_000 }),
        ({ active }, a, b) => {
          const small = new Set(selectIdle(active, NOW, Math.min(a, b)));
          const large = new Set(selectIdle(active, NOW, Math.max(a, b)));
          for (const id of large) expect(small.has(id)).toBe(true);
        },
      ),
    );
  });

  it("fails safe on a malformed lastActivity — a NaN age is never idled", () => {
    const active: ActiveWorkspace[] = [
      { id: workspaceId("ws-bad"), lastActivity: isoTimestamp("nope") },
    ];
    expect(selectIdle(active, NOW, 0)).toEqual([]);
  });

  it("never selects an always-on workspace, whatever its idle age or the threshold", () => {
    fc.assert(
      fc.property(
        activeArb,
        fc.integer({ min: 0, max: 30 * 86_400_000 }),
        ({ active }, threshold) => {
          const alwaysOn = active.map((w) => ({ ...w, alwaysOn: true }));
          expect(selectIdle(alwaysOn, NOW, threshold)).toEqual([]);
        },
      ),
    );
  });

  it("honors a per-workspace idleStopMs over the deployment default", () => {
    const hourOld: ActiveWorkspace = {
      id: workspaceId("ws-hour"),
      lastActivity: isoTimestamp(new Date(NOW_MS - 3_600_000).toISOString()),
    };
    // Deployment default (5s) would select it; its own longer window must win.
    expect(selectIdle([{ ...hourOld, idleStopMs: 7_200_000 }], NOW, 5_000)).toEqual([]);
    // And its own shorter window must select it even under a huge default.
    expect(selectIdle([{ ...hourOld, idleStopMs: 60_000 }], NOW, 86_400_000)).toEqual([
      hourOld.id,
    ]);
  });
});
