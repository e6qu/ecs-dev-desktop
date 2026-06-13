// SPDX-License-Identifier: AGPL-3.0-or-later
// Concurrency-pair safety: the optimistic-concurrency `version` guard must make
// EVERY transition pair safe, not just the connect/start race proven in the e2e
// tier. Two simultaneous transitions on one workspace must yield exactly one
// success and one clean conflict (a typed DomainError, never a thrown 500),
// with no double side effect — and crucially, a delete racing a wake must not
// orphan the freshly-launched task. Runs against DynamoDB Local with fakes
// (the version CAS lives at the DB boundary, so fakes exercise it faithfully).
import {
  baseImage,
  FakeComputeProvider,
  FakeStorageProvider,
  ownerId,
  systemClock,
  workspaceId,
  type Result,
  type DomainError,
} from "@edd/core";
import { createDynamoClient, dropTable, dynamodb, ensureTable, makeWorkspaceEntity } from "@edd/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceService } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const TABLE = "ecs-dev-desktop-cp-concurrency-integ";

/** Count of ok / conflict across a set of settled transition results. */
function tally(results: Result<unknown, DomainError>[]): { ok: number; conflict: number } {
  let ok = 0;
  let conflict = 0;
  for (const r of results) {
    if (r.ok) ok += 1;
    else if (r.error.kind === "conflict" || r.error.kind === "not_found") conflict += 1;
  }
  return { ok, conflict };
}

describe("concurrent transition pairs are version-safe (DynamoDB Local + fakes)", () => {
  let client: ReturnType<typeof createDynamoClient>;
  let storage: FakeStorageProvider;
  let compute: FakeComputeProvider;
  let service: WorkspaceService;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TABLE);
    await ensureTable(client, TABLE);
  });

  beforeEach(async () => {
    storage = await FakeStorageProvider.create();
    compute = new FakeComputeProvider(storage);
    service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, TABLE),
      storage,
      compute,
      clock: systemClock,
    });
  });

  afterAll(async () => {
    await dropTable(client, TABLE);
  });

  async function runningWorkspace(owner: string): Promise<string> {
    const ws = await service.create({
      ownerId: ownerId(owner),
      baseImage: baseImage("golden/node:20"),
    });
    return ws.id;
  }

  it("stop vs snapshot: exactly one wins, the other conflicts; never both", async () => {
    const id = await runningWorkspace("pair-a");
    const [stop, snap] = await Promise.all([
      service.stop(workspaceId(id)),
      service.snapshot(workspaceId(id)),
    ]);
    const { ok, conflict } = tally([stop, snap]);
    expect(ok).toBe(1);
    expect(conflict).toBe(1);
    // stop always wins or loses cleanly; the terminal state is consistent.
    const final = await service.get(workspaceId(id));
    expect(["running", "stopped"]).toContain(final?.state);
  });

  it("stop vs heartbeat: one wins, the other conflicts", async () => {
    const id = await runningWorkspace("pair-b");
    const [stop, beat] = await Promise.all([
      service.stop(workspaceId(id)),
      service.heartbeat(workspaceId(id)),
    ]);
    expect(tally([stop, beat])).toEqual({ ok: 1, conflict: 1 });
  });

  it("two concurrent snapshots: one wins, one conflicts (no lost update)", async () => {
    const id = await runningWorkspace("pair-c");
    const results = await Promise.all([
      service.snapshot(workspaceId(id)),
      service.snapshot(workspaceId(id)),
    ]);
    expect(tally(results)).toEqual({ ok: 1, conflict: 1 });
  });

  it("delete vs wake: never orphans the woken task, never double-succeeds", async () => {
    // A stopped workspace with a snapshot can be woken; deleting it concurrently
    // must not remove the record while start() launches a new task (the old
    // unconditional delete leaked that task).
    const id = await runningWorkspace("pair-d");
    expect((await service.stop(workspaceId(id))).ok).toBe(true);
    const volumesBefore = (await storage.listVolumes()).length;

    const [del, start] = await Promise.all([
      service.remove(workspaceId(id)),
      service.start(workspaceId(id)),
    ]);

    const delOk = del.ok;
    const startOk = start.ok;
    // At most one mutation "wins" cleanly; they cannot both succeed and leave a
    // running task with no record.
    const finalLoaded = await service.get(workspaceId(id));
    if (delOk && !startOk) {
      // Delete won: record gone, and start compensated its task (no new volume).
      expect(finalLoaded).toBeNull();
      expect((await storage.listVolumes()).length).toBe(volumesBefore);
    } else if (startOk && !delOk) {
      // Wake won: record present and running, backed by exactly one live volume.
      expect(finalLoaded?.state).toBe("running");
      expect((await storage.listVolumes()).length).toBe(volumesBefore + 1);
    } else {
      throw new Error(
        `delete/wake race must have exactly one winner (delOk=${String(delOk)}, startOk=${String(startOk)})`,
      );
    }
  });
});
