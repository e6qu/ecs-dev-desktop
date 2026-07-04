// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  provision,
  markStopped,
  markWaking,
  markProvisioned,
  markTaskLost,
  markActivity,
  recordFunctional,
  markDeleting,
  markRecovered,
  markSnapshotLost,
  isUnrecoverable,
  type Workspace,
} from "./workspace";
import { can, transition, type WorkspaceState } from "../lifecycle/workspace-state-machine";
import { baseImage, isoTimestamp, ownerId, snapshotId, taskId, volumeId, workspaceId } from "./ids";

const ALL_STATES: WorkspaceState[] = [
  "provisioning",
  "running",
  "idle",
  "stopped",
  "deleting",
  "terminated",
  "error",
];

const NOW = isoTimestamp("2026-01-01T00:00:00.000Z");

function makeWs(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: workspaceId("ws-test"),
    ownerId: ownerId("alice"),
    baseImage: baseImage("golden/node:20"),
    state: "running",
    desiredState: "present",
    createdAt: NOW,
    lastActivity: NOW,
    volumeId: volumeId("vol-1"),
    taskId: taskId("task-1"),
    ...overrides,
  };
}

describe("workspace lifecycle mutators (fuzz)", () => {
  describe("markStopped", () => {
    it("ok result always transitions via the state machine", () => {
      for (const state of ALL_STATES) {
        const ws = makeWs({ state, latestSnapshotId: snapshotId("snap-1") });
        const result = markStopped(ws, undefined, NOW);
        if (result.ok) {
          const expected = transition(state, "stop");
          expect(expected.ok, `markStopped ok but transition stop from ${state} is err`).toBe(true);
          if (expected.ok) expect(result.value.state).toBe(expected.value);
        } else {
          expect(
            can(state, "stop"),
            `markStopped err but transition stop from ${state} is ok`,
          ).toBe(false);
        }
      }
    });

    it("ok result always clears volumeId/taskId/sshHost", () => {
      for (const state of ALL_STATES) {
        const ws = makeWs({
          state,
          volumeId: volumeId("vol-1"),
          taskId: taskId("task-1"),
          sshHost: "10.0.0.1",
          latestSnapshotId: snapshotId("snap-1"),
        });
        const result = markStopped(ws, undefined, NOW);
        if (result.ok) {
          expect(result.value.volumeId).toBeUndefined();
          expect(result.value.taskId).toBeUndefined();
          expect(result.value.sshHost).toBeUndefined();
        }
      }
    });

    it("preserves all immutable fields (id, ownerId, baseImage, createdAt)", () => {
      const ws = makeWs({ state: "running", latestSnapshotId: snapshotId("snap-1") });
      const result = markStopped(ws, undefined, NOW);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(ws.id);
        expect(result.value.ownerId).toBe(ws.ownerId);
        expect(result.value.baseImage).toBe(ws.baseImage);
        expect(result.value.createdAt).toBe(ws.createdAt);
      }
    });
  });

  describe("markWaking", () => {
    it("ok iff transition(state, 'wake') is ok", () => {
      for (const state of ALL_STATES) {
        const ws = makeWs({ state });
        const result = markWaking(ws, NOW);
        expect(result.ok).toBe(can(state, "wake"));
      }
    });
  });

  describe("markProvisioned", () => {
    it("ok iff transition(state, 'provisioned') is ok", () => {
      for (const state of ALL_STATES) {
        const ws = makeWs({ state });
        const result = markProvisioned(ws, volumeId("vol-2"), taskId("task-2"), NOW);
        expect(result.ok).toBe(can(state, "provisioned"));
      }
    });

    it("ok result sets the new bindings", () => {
      const ws = makeWs({ state: "provisioning" });
      const result = markProvisioned(ws, volumeId("vol-2"), taskId("task-2"), NOW, "10.0.0.2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.volumeId).toBe(volumeId("vol-2"));
        expect(result.value.taskId).toBe(taskId("task-2"));
        expect(result.value.sshHost).toBe("10.0.0.2");
      }
    });
  });

  describe("markActivity", () => {
    it("ok iff state is running or idle", () => {
      for (const state of ALL_STATES) {
        const ws = makeWs({ state });
        const result = markActivity(ws, NOW);
        expect(result.ok).toBe(state === "running" || state === "idle");
      }
    });

    it("always updates lastActivity on ok", () => {
      const later = isoTimestamp("2026-06-01T12:00:00.000Z");
      for (const state of ["running", "idle"] as const) {
        const ws = makeWs({ state, lastActivity: NOW });
        const result = markActivity(ws, later);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.lastActivity).toBe(later);
      }
    });
  });

  describe("recordFunctional", () => {
    it("never throws for any probe combination", () => {
      const ws = makeWs();
      const probes = [
        { ide: true, workspace: true },
        { ide: false, workspace: true },
        { ide: true, workspace: false },
        { ide: false, workspace: false },
      ];
      for (const p of probes) {
        expect(() => recordFunctional(ws, p, NOW)).not.toThrow();
      }
    });

    it("ok iff both probes pass; degraded otherwise", () => {
      const ws = makeWs();
      expect(recordFunctional(ws, { ide: true, workspace: true }, NOW).functional).toBe("ok");
      expect(recordFunctional(ws, { ide: false, workspace: true }, NOW).functional).toBe(
        "degraded",
      );
      expect(recordFunctional(ws, { ide: true, workspace: false }, NOW).functional).toBe(
        "degraded",
      );
      expect(recordFunctional(ws, { ide: false, workspace: false }, NOW).functional).toBe(
        "degraded",
      );
    });
  });

  describe("markTaskLost", () => {
    it("ok only for active states with a taskId", () => {
      for (const state of ALL_STATES) {
        const ws = makeWs({ state, taskId: taskId("task-1") });
        const result = markTaskLost(ws, NOW);
        const expectedActive = state === "provisioning" || state === "running" || state === "idle";
        expect(result.ok).toBe(expectedActive);
      }
    });

    it("err for active state without taskId", () => {
      for (const state of ["provisioning", "running", "idle"] as const) {
        const ws = makeWs({ state, taskId: undefined });
        expect(markTaskLost(ws, NOW).ok).toBe(false);
      }
    });

    it("ok result → stopped if snapshot exists, error otherwise", () => {
      const withSnap = makeWs({ state: "running", latestSnapshotId: snapshotId("snap-1") });
      const withoutSnap = makeWs({ state: "running", latestSnapshotId: undefined });
      const r1 = markTaskLost(withSnap, NOW);
      const r2 = markTaskLost(withoutSnap, NOW);
      expect(r1.ok && r1.value.state).toBe("stopped");
      expect(r2.ok && r2.value.state).toBe("error");
    });
  });

  describe("markDeleting", () => {
    it("ok from every state except terminated; deleting is idempotent", () => {
      for (const state of ALL_STATES) {
        const ws = makeWs({ state });
        const result = markDeleting(ws, NOW);
        if (state === "deleting") {
          expect(result.ok).toBe(true); // idempotent
          if (result.ok) expect(result.value).toEqual(ws);
        } else {
          expect(result.ok).toBe(can(state, "requestDelete"));
        }
      }
    });
  });

  describe("markRecovered", () => {
    it("ok only from error with a snapshot", () => {
      for (const state of ALL_STATES) {
        const ws = makeWs({ state, latestSnapshotId: snapshotId("snap-1") });
        const result = markRecovered(ws, NOW);
        expect(result.ok).toBe(state === "error");
      }
    });

    it("err from error without a snapshot", () => {
      const ws = makeWs({ state: "error", latestSnapshotId: undefined });
      expect(markRecovered(ws, NOW).ok).toBe(false);
    });
  });

  describe("markSnapshotLost", () => {
    it("ok only from stopped or error with a snapshot", () => {
      for (const state of ALL_STATES) {
        const ws = makeWs({ state, latestSnapshotId: snapshotId("snap-1") });
        const result = markSnapshotLost(ws, NOW);
        expect(result.ok).toBe(state === "stopped" || state === "error");
      }
    });

    it("ok result always → error state with snapshot cleared", () => {
      for (const state of ["stopped", "error"] as const) {
        const ws = makeWs({ state, latestSnapshotId: snapshotId("snap-1"), latestSnapshotAt: NOW });
        const result = markSnapshotLost(ws, NOW);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.state).toBe("error");
          expect(result.value.latestSnapshotId).toBeUndefined();
          expect(result.value.latestSnapshotAt).toBeUndefined();
        }
      }
    });
  });

  describe("isUnrecoverable", () => {
    it("true only for error state without a snapshot", () => {
      for (const state of ALL_STATES) {
        for (const hasSnap of [true, false]) {
          const ws = makeWs({
            state,
            latestSnapshotId: hasSnap ? snapshotId("snap-1") : undefined,
          });
          expect(isUnrecoverable(ws)).toBe(state === "error" && !hasSnap);
        }
      }
    });
  });

  describe("provision + markStopped round-trip", () => {
    it("provisioning a workspace and stopping it yields a stopped workspace", () => {
      const ws = provision({
        id: workspaceId("ws-1"),
        ownerId: ownerId("alice"),
        baseImage: baseImage("golden/node:20"),
        volumeId: volumeId("vol-1"),
        taskId: taskId("task-1"),
        at: NOW,
      });
      const stopped = markStopped(ws, { id: snapshotId("snap-1"), at: NOW }, NOW);
      expect(stopped.ok).toBe(true);
      if (stopped.ok) {
        expect(stopped.value.state).toBe("stopped");
        expect(stopped.value.volumeId).toBeUndefined();
        expect(stopped.value.taskId).toBeUndefined();
        expect(stopped.value.latestSnapshotId).toBe(snapshotId("snap-1"));
      }
    });
  });
});
