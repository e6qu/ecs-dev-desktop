// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based fuzz tests (fast-check) for the workspace lifecycle mutators.
// The state machine itself is already fuzzed (state-machine.fuzz.test.ts); these
// tests verify the wrappers that compose the machine with field-clearing and
// retention invariants — drift here = silent data corruption (e.g. a stop that
// fails to clear taskId).
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isOk } from "../result";
import { can, type WorkspaceState } from "../lifecycle/workspace-state-machine";
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
import { baseImage, isoTimestamp, ownerId, snapshotId, taskId, volumeId, workspaceId } from "./ids";

const STATES: readonly WorkspaceState[] = [
  "provisioning",
  "running",
  "idle",
  "stopped",
  "deleting",
  "terminated",
  "error",
];

const stateArb = fc.constantFrom(...STATES);

/** Generate a random Workspace with a given (or random) state. */
function workspaceArb(stateOverride?: WorkspaceState): fc.Arbitrary<Workspace> {
  return fc
    .record({
      id: fc.constant(workspaceId("ws-fuzz")),
      ownerId: fc.constant(ownerId("alice")),
      baseImage: fc.constant(baseImage("golden/node:20")),
      resources: fc.constant({ cpuUnits: 512, memoryMiB: 2048, volumeGiB: 8 } as const),
      state: stateOverride !== undefined ? fc.constant(stateOverride) : stateArb,
      desiredState: fc.constant("present" as const),
      createdAt: fc.constant(isoTimestamp("2026-01-01T00:00:00.000Z")),
      lastActivity: fc.constant(isoTimestamp("2026-01-01T00:00:00.000Z")),
      volumeId: fc.option(fc.constant(volumeId("vol-1")), { nil: undefined }),
      taskId: fc.option(fc.constant(taskId("task-1")), { nil: undefined }),
      latestSnapshotId: fc.option(fc.constant(snapshotId("snap-1")), { nil: undefined }),
      latestSnapshotAt: fc.option(fc.constant(isoTimestamp("2026-01-01T00:00:00.000Z")), {
        nil: undefined,
      }),
      sshHost: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
    })
    .map((r) => ({
      id: r.id,
      ownerId: r.ownerId,
      baseImage: r.baseImage,
      resources: r.resources,
      state: r.state,
      desiredState: r.desiredState,
      createdAt: r.createdAt,
      lastActivity: r.lastActivity,
      volumeId: r.volumeId,
      taskId: r.taskId,
      latestSnapshotId: r.latestSnapshotId,
      latestSnapshotAt: r.latestSnapshotAt,
      sshHost: r.sshHost,
    }));
}

const NOW = isoTimestamp("2026-06-01T12:00:00.000Z");

describe("workspace lifecycle mutators (fuzz)", () => {
  it("markStopped: ok iff transition(state,'stop') is ok; ok result clears bindings", () => {
    fc.assert(
      fc.property(workspaceArb(), (ws) => {
        const result = markStopped(ws, undefined, NOW);
        expect(isOk(result)).toBe(can(ws.state, "stop"));
        if (isOk(result)) {
          expect(result.value.volumeId).toBeUndefined();
          expect(result.value.taskId).toBeUndefined();
          expect(result.value.sshHost).toBeUndefined();
          // Immutable fields preserved
          expect(result.value.id).toBe(ws.id);
          expect(result.value.ownerId).toBe(ws.ownerId);
          expect(result.value.baseImage).toBe(ws.baseImage);
          expect(result.value.createdAt).toBe(ws.createdAt);
        }
      }),
    );
  });

  it("markWaking: ok iff transition(state,'wake') is ok", () => {
    fc.assert(
      fc.property(workspaceArb(), (ws) => {
        const result = markWaking(ws, NOW);
        expect(isOk(result)).toBe(can(ws.state, "wake"));
      }),
    );
  });

  it("markProvisioned: ok iff transition(state,'provisioned') is ok; sets new bindings", () => {
    fc.assert(
      fc.property(workspaceArb(), (ws) => {
        const result = markProvisioned(ws, volumeId("vol-2"), taskId("task-2"), NOW, "10.0.0.2");
        expect(isOk(result)).toBe(can(ws.state, "provisioned"));
        if (isOk(result)) {
          expect(result.value.volumeId).toBe(volumeId("vol-2"));
          expect(result.value.taskId).toBe(taskId("task-2"));
          expect(result.value.sshHost).toBe("10.0.0.2");
        }
      }),
    );
  });

  it("markActivity: ok iff running or idle; always updates lastActivity on ok", () => {
    fc.assert(
      fc.property(workspaceArb(), (ws) => {
        const result = markActivity(ws, NOW);
        expect(isOk(result)).toBe(ws.state === "running" || ws.state === "idle");
        if (isOk(result)) expect(result.value.lastActivity).toBe(NOW);
      }),
    );
  });

  it("recordFunctional: never throws for any probe combination", () => {
    fc.assert(
      fc.property(
        workspaceArb("running"),
        fc.record({ ide: fc.boolean(), workspace: fc.boolean() }),
        (ws, probes) => {
          const result = recordFunctional(ws, probes, NOW);
          expect(result.functional).toBe(probes.ide && probes.workspace ? "ok" : "degraded");
        },
      ),
    );
  });

  it("markTaskLost: ok only for active states with a taskId; ok→stopped if snapshot, error otherwise", () => {
    fc.assert(
      fc.property(workspaceArb(), (ws) => {
        const result = markTaskLost(ws, NOW);
        const activeWithTask =
          (ws.state === "provisioning" || ws.state === "running" || ws.state === "idle") &&
          ws.taskId !== undefined;
        expect(isOk(result)).toBe(activeWithTask);
        if (isOk(result)) {
          expect(result.value.volumeId).toBeUndefined();
          expect(result.value.taskId).toBeUndefined();
          if (ws.latestSnapshotId !== undefined) {
            expect(result.value.state).toBe("stopped");
          } else {
            expect(result.value.state).toBe("error");
          }
        }
      }),
    );
  });

  it("markDeleting: ok from any state that allows requestDelete; deleting is idempotent", () => {
    fc.assert(
      fc.property(workspaceArb(), (ws) => {
        const result = markDeleting(ws, NOW);
        if (ws.state === "deleting") {
          expect(isOk(result)).toBe(true);
        } else {
          expect(isOk(result)).toBe(can(ws.state, "requestDelete"));
        }
      }),
    );
  });

  it("markRecovered: ok only from error with a snapshot; ok→stopped", () => {
    fc.assert(
      fc.property(workspaceArb(), (ws) => {
        const result = markRecovered(ws, NOW);
        expect(isOk(result)).toBe(ws.state === "error" && ws.latestSnapshotId !== undefined);
        if (isOk(result)) expect(result.value.state).toBe("stopped");
      }),
    );
  });

  it("markSnapshotLost: ok only from stopped/error with a snapshot; ok→error with cleared snapshot", () => {
    fc.assert(
      fc.property(workspaceArb(), (ws) => {
        const result = markSnapshotLost(ws, NOW);
        expect(isOk(result)).toBe(
          (ws.state === "stopped" || ws.state === "error") && ws.latestSnapshotId !== undefined,
        );
        if (isOk(result)) {
          expect(result.value.state).toBe("error");
          expect(result.value.latestSnapshotId).toBeUndefined();
          expect(result.value.latestSnapshotAt).toBeUndefined();
        }
      }),
    );
  });

  it("isUnrecoverable: true only for error state without a snapshot", () => {
    fc.assert(
      fc.property(workspaceArb(), (ws) => {
        expect(isUnrecoverable(ws)).toBe(ws.state === "error" && ws.latestSnapshotId === undefined);
      }),
    );
  });

  it("assertTerminable: ok iff transition(state,'requestDelete') is ok", () => {
    fc.assert(
      fc.property(workspaceArb(), (ws) => {
        const result = provision({
          ...ws,
          id: workspaceId("ws-x"),
          volumeId: volumeId("v"),
          taskId: taskId("t"),
          at: NOW,
        });
        // assertTerminable doesn't depend on ws fields, only state
        const term = markDeleting(result, NOW);
        expect(isOk(term)).toBe(can(result.state, "requestDelete") || result.state === "deleting");
      }),
    );
  });

  it("provision + markStopped round-trip: provision then stop yields stopped with cleared bindings", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (name) => {
        const ws = provision({
          id: workspaceId(`ws-${name.slice(0, 8)}`),
          ownerId: ownerId("alice"),
          baseImage: baseImage("golden/node:20"),
          volumeId: volumeId("vol-1"),
          taskId: taskId("task-1"),
          at: NOW,
        });
        const stopped = markStopped(ws, { id: snapshotId("snap-1"), at: NOW }, NOW);
        expect(isOk(stopped)).toBe(true);
        if (isOk(stopped)) {
          expect(stopped.value.state).toBe("stopped");
          expect(stopped.value.volumeId).toBeUndefined();
          expect(stopped.value.taskId).toBeUndefined();
          expect(stopped.value.latestSnapshotId).toBe(snapshotId("snap-1"));
        }
      }),
    );
  });
});
