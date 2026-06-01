// SPDX-License-Identifier: AGPL-3.0-or-later
import { fixedClock, isoTimestamp, workspaceId } from "@edd/core";
import { describe, expect, it } from "vitest";

import { Reconciler, selectIdle, type ActiveWorkspace, type ReconcilerService } from "./index";

const THIRTY_MIN = 30 * 60 * 1000;

describe("selectIdle", () => {
  it("selects only workspaces idle past the threshold", () => {
    const now = isoTimestamp("2026-06-01T01:00:00.000Z");
    const active: ActiveWorkspace[] = [
      { id: workspaceId("ws-old"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
      { id: workspaceId("ws-fresh"), lastActivity: isoTimestamp("2026-06-01T00:59:00.000Z") },
    ];
    expect(selectIdle(active, now, THIRTY_MIN)).toEqual([workspaceId("ws-old")]);
  });
});

describe("Reconciler.runOnce", () => {
  it("stops idle workspaces and reports a summary", async () => {
    const stopped: string[] = [];
    const service: ReconcilerService = {
      listActive: () =>
        Promise.resolve([
          { id: workspaceId("ws-1"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
        ]),
      stop: (id) => {
        stopped.push(id);
        return Promise.resolve();
      },
    };

    const reconciler = new Reconciler({
      service,
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      idleThresholdMs: 1000,
    });

    expect(await reconciler.runOnce()).toEqual({ scanned: 1, stopped: 1 });
    expect(stopped).toEqual(["ws-1"]);
  });

  it("leaves freshly-active workspaces running", async () => {
    const service: ReconcilerService = {
      listActive: () =>
        Promise.resolve([
          { id: workspaceId("ws-1"), lastActivity: isoTimestamp("2026-06-01T01:59:00.000Z") },
        ]),
      stop: () => Promise.reject(new Error("should not stop")),
    };
    const reconciler = new Reconciler({
      service,
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      idleThresholdMs: THIRTY_MIN,
    });
    expect(await reconciler.runOnce()).toEqual({ scanned: 1, stopped: 0 });
  });
});
