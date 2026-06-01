// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { InvalidTransitionError } from "../lifecycle/workspace-state-machine";
import { baseImage, isoTimestamp, ownerId, snapshotId, taskId, volumeId, workspaceId } from "./ids";
import { markStarted, markStopped, provision, recordSnapshot } from "./workspace";

const t0 = isoTimestamp("2026-06-01T00:00:00.000Z");
const t1 = isoTimestamp("2026-06-01T01:00:00.000Z");

const base = provision({
  id: workspaceId("ws-1"),
  ownerId: ownerId("alice"),
  baseImage: baseImage("golden/node:20"),
  volumeId: volumeId("vol-1"),
  taskId: taskId("task-1"),
  at: t0,
});

describe("workspace domain (functional core)", () => {
  it("provisions a running workspace", () => {
    expect(base.state).toBe("running");
    expect(base.volumeId).toBe("vol-1");
  });

  it("stop snapshots and clears runtime bindings", () => {
    const stopped = markStopped(base, snapshotId("snap-1"), t1);
    expect(stopped.state).toBe("stopped");
    expect(stopped.latestSnapshotId).toBe("snap-1");
    expect(stopped.volumeId).toBeUndefined();
    expect(stopped.taskId).toBeUndefined();
  });

  it("start re-binds volume and task", () => {
    const stopped = markStopped(base, snapshotId("snap-1"), t1);
    const started = markStarted(stopped, volumeId("vol-2"), taskId("task-2"), t1);
    expect(started.state).toBe("running");
    expect(started.volumeId).toBe("vol-2");
  });

  it("rejects an illegal transition (stop while stopped)", () => {
    const stopped = markStopped(base, snapshotId("snap-1"), t1);
    expect(() => markStopped(stopped, undefined, t1)).toThrow(InvalidTransitionError);
  });

  it("records a point-in-time snapshot", () => {
    expect(recordSnapshot(base, snapshotId("snap-9"), t1).latestSnapshotId).toBe("snap-9");
  });
});
