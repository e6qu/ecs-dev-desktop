// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isoTimestamp } from "../domain/ids";
import { deriveFleetAudit } from "./audit";

const t = (h: number) => isoTimestamp(`2026-06-04T0${h.toString()}:00:00.000Z`);

describe("deriveFleetAudit", () => {
  it("derives one event per workspace lifecycle point, newest first", () => {
    const events = deriveFleetAudit([
      { workspaceId: "ws-a", createdAt: t(0), lastActivity: t(2), latestSnapshotAt: t(1) },
    ]);
    expect(events.map((e) => e.action)).toEqual([
      "workspace.activity",
      "workspace.snapshot",
      "workspace.created",
    ]);
    expect(events.every((e) => e.target === "ws-a")).toBe(true);
    expect(events.every((e) => e.actor === "system")).toBe(true);
  });

  it("interleaves events across workspaces by time (newest first)", () => {
    const events = deriveFleetAudit([
      { workspaceId: "ws-a", createdAt: t(0), lastActivity: t(0) },
      { workspaceId: "ws-b", createdAt: t(3), lastActivity: t(3) },
    ]);
    expect(events.map((e) => e.target)).toEqual(["ws-b", "ws-a"]);
  });

  it("caps the feed at the requested limit", () => {
    const items = [0, 1, 2, 3].map((h) => ({
      workspaceId: `ws-${h.toString()}`,
      createdAt: t(h),
      lastActivity: t(h),
    }));
    const events = deriveFleetAudit(items, 2);
    expect(events).toHaveLength(2);
    expect(events[0]?.target).toBe("ws-3"); // newest kept
  });
});
