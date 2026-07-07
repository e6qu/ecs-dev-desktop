// SPDX-License-Identifier: AGPL-3.0-or-later
// Route-level coverage for the four body-less lifecycle transitions —
// stop (scale to zero), start (wake from snapshot), snapshot (point-in-time),
// and connect (wake-on-connect, the SSH gateway's entry point). One file: the
// routes share the harness and together they walk one workspace state machine.
import { workspace, workspaceInspection } from "@edd/api-contracts";
import { describe, expect, it } from "vitest";

import {
  admin,
  createWorkspaceFor,
  stopWorkspaceFor,
  postLifecycle,
  useWorkspaceTable,
} from "../../../../lib/test-support/workspace-route-harness";
import { GET as inspect } from "../../admin/workspaces/[id]/route";
import { POST as connect } from "./connect/route";
import { POST as snapshot } from "./snapshot/route";
import { POST as start } from "./start/route";
import { POST as stop } from "./stop/route";

useWorkspaceTable("ecs-dev-des-web-lifecycle-integ");

const doStop = (actor: string, id: string) => postLifecycle(stop, "stop", actor, id);
const doStart = (actor: string, id: string) => postLifecycle(start, "start", actor, id);
const doSnapshot = (actor: string, id: string) => postLifecycle(snapshot, "snapshot", actor, id);
const doConnect = (actor: string, id: string) => postLifecycle(connect, "connect", actor, id);

/** Full persisted detail via the admin Inspect route (the slim DTO hides bindings). */
async function detail(id: string) {
  const res = await inspect(
    new Request(`http://localhost/api/admin/workspaces/${id}`, { headers: admin("root") }),
    { params: Promise.resolve({ id }) },
  );
  expect(res.status).toBe(200);
  return workspaceInspection.parse(await res.json()).workspace;
}

async function expectState(res: Response, state: string): Promise<void> {
  expect(res.status).toBe(200);
  expect(workspace.parse(await res.json()).state).toBe(state);
}

describe("POST /api/workspaces/:id/stop (DynamoDB Local)", () => {
  it("stops a running workspace: snapshot recorded, task+volume released", async () => {
    const id = await createWorkspaceFor("stop-a");
    // Manual stop is async now (route -> `stopping`, converge -> stopped).
    expect((await doStop("stop-a", id)).status).toBe(200);
    await stopWorkspaceFor(id); // finish the converge deterministically

    const d = await detail(id);
    expect(d.latestSnapshotId).toBeDefined();
    expect(d.latestSnapshotAt).toBeDefined();
    expect(d.taskId).toBeUndefined();
    expect(d.volumeId).toBeUndefined();
  });

  it("rejects stopping an already-stopped workspace (409)", async () => {
    const id = await createWorkspaceFor("stop-b");
    await stopWorkspaceFor(id);
    expect((await doStop("stop-b", id)).status).toBe(409);
  });
});

describe("POST /api/workspaces/:id/start (DynamoDB Local)", () => {
  it("wakes a stopped workspace: fresh task+volume hydrated from the stop snapshot", async () => {
    const id = await createWorkspaceFor("start-a");
    const before = await detail(id);
    await stopWorkspaceFor(id);
    const stopped = await detail(id);

    await expectState(await doStart("start-a", id), "running");

    const after = await detail(id);
    expect(after.taskId).toBeDefined();
    expect(after.volumeId).toBeDefined();
    expect(after.taskId).not.toBe(before.taskId);
    expect(after.volumeId).not.toBe(before.volumeId);
    expect(after.latestSnapshotId).toBe(stopped.latestSnapshotId);
  });

  it("rejects starting an already-running workspace (409)", async () => {
    const id = await createWorkspaceFor("start-b");
    expect((await doStart("start-b", id)).status).toBe(409);
  });
});

describe("POST /api/workspaces/:id/snapshot (DynamoDB Local)", () => {
  it("takes a point-in-time snapshot; a second one replaces the recorded latest", async () => {
    const id = await createWorkspaceFor("snap-a");
    expect((await detail(id)).latestSnapshotId).toBeUndefined();

    await expectState(await doSnapshot("snap-a", id), "running");
    const first = (await detail(id)).latestSnapshotId;
    expect(first).toBeDefined();

    expect((await doSnapshot("snap-a", id)).status).toBe(200);
    const second = (await detail(id)).latestSnapshotId;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("rejects snapshotting a stopped workspace — no active volume (409)", async () => {
    const id = await createWorkspaceFor("snap-b");
    await stopWorkspaceFor(id);
    expect((await doSnapshot("snap-b", id)).status).toBe(409);
  });
});

describe("POST /api/workspaces/:id/connect — wake-on-connect (DynamoDB Local)", () => {
  it("is a no-op on a running workspace: the same task keeps serving", async () => {
    const id = await createWorkspaceFor("conn-a");
    const before = await detail(id);

    await expectState(await doConnect("conn-a", id), "running");

    const after = await detail(id);
    expect(after.taskId).toBe(before.taskId);
    expect(after.volumeId).toBe(before.volumeId);
  });

  it("wakes a scaled-to-zero workspace from its snapshot, idempotently", async () => {
    const id = await createWorkspaceFor("conn-b");
    await stopWorkspaceFor(id);
    const stopped = await detail(id);
    expect(stopped.state).toBe("stopped");

    await expectState(await doConnect("conn-b", id), "running");

    const woken = await detail(id);
    expect(woken.state).toBe("running");
    expect(woken.taskId).toBeDefined();
    expect(woken.latestSnapshotId).toBe(stopped.latestSnapshotId);

    // Second connect on the now-running workspace still succeeds (idempotent).
    await expectState(await doConnect("conn-b", id), "running");
    expect((await detail(id)).taskId).toBe(woken.taskId);
  });
});

describe("lifecycle routes: authz and existence", () => {
  it("forbids acting on another member's workspace (403, all four routes)", async () => {
    const id = await createWorkspaceFor("authz-a");
    for (const call of [doStop, doStart, doSnapshot, doConnect]) {
      expect((await call("mallory", id)).status).toBe(403);
    }
  });

  it("returns 404 for an unknown workspace (all four routes)", async () => {
    for (const call of [doStop, doStart, doSnapshot, doConnect]) {
      expect((await call("authz-a", "no-such-id")).status).toBe(404);
    }
  });
});
