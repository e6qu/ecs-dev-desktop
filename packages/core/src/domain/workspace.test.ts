// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { unwrap } from "../result";
import { baseImage, isoTimestamp, ownerId, snapshotId, taskId, volumeId, workspaceId } from "./ids";
import {
  isUnrecoverable,
  markActivity,
  markDeleting,
  markProvisioned,
  markRecovered,
  markSnapshotLost,
  markStopped,
  markTaskLost,
  markWaking,
  provision,
  recordSnapshot,
} from "./workspace";

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
    const stopped = unwrap(markStopped(base, { id: snapshotId("snap-1"), at: t1 }, t1));
    expect(stopped.state).toBe("stopped");
    expect(stopped.latestSnapshotId).toBe("snap-1");
    expect(stopped.latestSnapshotAt).toBe(t1);
    expect(stopped.volumeId).toBeUndefined();
    expect(stopped.taskId).toBeUndefined();
  });

  it("carries the prior snapshot when stopping without a fresh one", () => {
    const snapped = recordSnapshot(base, snapshotId("snap-1"), t0);
    const stopped = unwrap(markStopped(snapped, undefined, t1));
    expect(stopped.latestSnapshotId).toBe("snap-1");
    expect(stopped.latestSnapshotAt).toBe(t0);
  });

  it("wakes in two phases: claim (provisioning) then commit (running) re-binds volume + task", () => {
    const stopped = unwrap(markStopped(base, { id: snapshotId("snap-1"), at: t1 }, t1));
    // Phase 1 — claim: stopped → provisioning, no bindings yet.
    const waking = unwrap(markWaking(stopped, t1));
    expect(waking.state).toBe("provisioning");
    expect(waking.volumeId).toBeUndefined();
    expect(waking.taskId).toBeUndefined();
    // Phase 2 — commit: provisioning → running, binds the launched task.
    const started = unwrap(markProvisioned(waking, volumeId("vol-2"), taskId("task-2"), t1));
    expect(started.state).toBe("running");
    expect(started.volumeId).toBe("vol-2");
  });

  it("cancels an in-flight wake back to stopped (rollback), keeping the snapshot", () => {
    const stopped = unwrap(markStopped(base, { id: snapshotId("snap-1"), at: t1 }, t1));
    const waking = unwrap(markWaking(stopped, t1));
    const rolledBack = unwrap(markStopped(waking, undefined, t1));
    expect(rolledBack.state).toBe("stopped");
    expect(rolledBack.latestSnapshotId).toBe("snap-1");
  });

  it("rejects an illegal transition (stop while stopped) with a conflict", () => {
    const stopped = unwrap(markStopped(base, { id: snapshotId("snap-1"), at: t1 }, t1));
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
    const active = unwrap(markActivity(base, t1));
    expect(active.state).toBe("running");
    expect(active.lastActivity).toBe(t1);
  });

  it("activity wakes an idle workspace back to running", () => {
    const idle = { ...base, state: "idle" as const };
    const active = unwrap(markActivity(idle, t1));
    expect(active.state).toBe("running");
    expect(active.lastActivity).toBe(t1);
  });

  it("rejects activity on a non-active workspace with a conflict", () => {
    const stopped = unwrap(markStopped(base, { id: snapshotId("snap-1"), at: t1 }, t1));
    const result = markActivity(stopped, t1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("task loss with a snapshot transitions to stopped and clears bindings", () => {
    const snapped = recordSnapshot(base, snapshotId("snap-7"), t1);
    const lost = unwrap(markTaskLost(snapped, t1));
    expect(lost.state).toBe("stopped");
    expect(lost.taskId).toBeUndefined();
    expect(lost.volumeId).toBeUndefined();
    expect(lost.sshHost).toBeUndefined();
    expect(lost.latestSnapshotId).toBe("snap-7");
  });

  it("task loss without a snapshot transitions to error (nothing restorable)", () => {
    const lost = unwrap(markTaskLost(base, t1));
    expect(lost.state).toBe("error");
    expect(lost.taskId).toBeUndefined();
  });

  it("rejects task loss on a stopped workspace with a conflict", () => {
    const stopped = unwrap(markStopped(base, { id: snapshotId("snap-1"), at: t1 }, t1));
    const result = markTaskLost(stopped, t1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  // ── Self-recovery: desired-state, tombstone, error recovery ──────────────────

  it("markDeleting tombstones the workspace with desiredState=deleted", () => {
    const deleting = unwrap(markDeleting(base, t1));
    expect(deleting.state).toBe("deleting");
    expect(deleting.desiredState).toBe("deleted");
    expect(deleting.deleteRequestedAt).toBe(t1);
  });

  it("markDeleting is idempotent on an already-deleting workspace", () => {
    const deleting = unwrap(markDeleting(base, t1));
    expect(unwrap(markDeleting(deleting, t1))).toEqual(deleting);
  });

  it("markRecovered moves a recoverable error → stopped and clears live bindings", () => {
    // error WITH a snapshot is recoverable
    const lost = unwrap(markTaskLost(recordSnapshot(base, snapshotId("snap-1"), t0), t1));
    const errored = { ...lost, state: "error" as const, latestSnapshotId: snapshotId("snap-1") };
    const recovered = unwrap(markRecovered(errored, t1));
    expect(recovered.state).toBe("stopped");
    expect(recovered.taskId).toBeUndefined();
    expect(recovered.latestSnapshotId).toBe("snap-1");
  });

  it("markRecovered refuses an error with no snapshot (unrecoverable)", () => {
    const errored = { ...base, state: "error" as const, latestSnapshotId: undefined };
    expect(isUnrecoverable(errored)).toBe(true);
    const result = markRecovered(errored, t1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("isUnrecoverable is false for an error that still has a snapshot", () => {
    const errored = { ...base, state: "error" as const, latestSnapshotId: snapshotId("snap-1") };
    expect(isUnrecoverable(errored)).toBe(false);
  });

  it("markSnapshotLost moves a stopped workspace → unrecoverable error, clearing the ref", () => {
    const stopped = unwrap(markStopped(base, { id: snapshotId("snap-1"), at: t1 }, t1));
    const lost = unwrap(markSnapshotLost(stopped, t1));
    expect(lost.state).toBe("error");
    expect(lost.latestSnapshotId).toBeUndefined();
    expect(isUnrecoverable(lost)).toBe(true);
  });

  it("markSnapshotLost refuses a running workspace (only stopped/error reference a snapshot)", () => {
    expect(markSnapshotLost(base, t1).ok).toBe(false);
  });
});
