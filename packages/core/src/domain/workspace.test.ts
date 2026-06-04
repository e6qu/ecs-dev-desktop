// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import type { Result } from "../result";
import type { DomainError } from "./errors";
import { baseImage, isoTimestamp, ownerId, snapshotId, taskId, volumeId, workspaceId } from "./ids";
import { markActivity, markStarted, markStopped, provision, recordSnapshot } from "./workspace";

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

/** Assert a Result is Ok and return its value (test helper). */
function val<T>(r: Result<T, DomainError>): T {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`expected ok, got ${r.error.kind}`);
  return r.value;
}

describe("workspace domain (functional core)", () => {
  it("provisions a running workspace", () => {
    expect(base.state).toBe("running");
    expect(base.volumeId).toBe("vol-1");
  });

  it("stop snapshots and clears runtime bindings", () => {
    const stopped = val(markStopped(base, { id: snapshotId("snap-1"), at: t1 }, t1));
    expect(stopped.state).toBe("stopped");
    expect(stopped.latestSnapshotId).toBe("snap-1");
    expect(stopped.latestSnapshotAt).toBe(t1);
    expect(stopped.volumeId).toBeUndefined();
    expect(stopped.taskId).toBeUndefined();
  });

  it("carries the prior snapshot when stopping without a fresh one", () => {
    const snapped = recordSnapshot(base, snapshotId("snap-1"), t0);
    const stopped = val(markStopped(snapped, undefined, t1));
    expect(stopped.latestSnapshotId).toBe("snap-1");
    expect(stopped.latestSnapshotAt).toBe(t0);
  });

  it("start re-binds volume and task", () => {
    const stopped = val(markStopped(base, { id: snapshotId("snap-1"), at: t1 }, t1));
    const started = val(markStarted(stopped, volumeId("vol-2"), taskId("task-2"), t1));
    expect(started.state).toBe("running");
    expect(started.volumeId).toBe("vol-2");
  });

  it("rejects an illegal transition (stop while stopped) with a conflict", () => {
    const stopped = val(markStopped(base, { id: snapshotId("snap-1"), at: t1 }, t1));
    const result = markStopped(stopped, undefined, t1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("records a point-in-time snapshot", () => {
    const snapped = recordSnapshot(base, snapshotId("snap-9"), t1);
    expect(snapped.latestSnapshotId).toBe("snap-9");
    expect(snapped.latestSnapshotAt).toBe(t1);
  });

  it("activity refreshes lastActivity on a running workspace", () => {
    const active = val(markActivity(base, t1));
    expect(active.state).toBe("running");
    expect(active.lastActivity).toBe(t1);
  });

  it("activity wakes an idle workspace back to running", () => {
    const idle = { ...base, state: "idle" as const };
    const active = val(markActivity(idle, t1));
    expect(active.state).toBe("running");
    expect(active.lastActivity).toBe(t1);
  });

  it("rejects activity on a non-active workspace with a conflict", () => {
    const stopped = val(markStopped(base, { id: snapshotId("snap-1"), at: t1 }, t1));
    const result = markActivity(stopped, t1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });
});
