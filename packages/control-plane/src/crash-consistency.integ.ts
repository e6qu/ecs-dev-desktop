// SPDX-License-Identifier: AGPL-3.0-or-later
// Crash-consistency: create()/start() perform the compute side effect BEFORE
// persisting. If the persistence write fails, the freshly launched task must
// be stopped (compensation) — otherwise a real ECS task leaks with no record
// referencing it. The outage is injected through the AWS SDK's public
// middleware stack (writes fail, reads pass), so the whole real persistence
// path up to DynamoDB is exercised.
import {
  baseImage,
  FakeComputeProvider,
  FakeStorageProvider,
  ownerId,
  systemClock,
  workspaceId,
} from "@edd/core";
import type { ComputeProvider, ComputeTask, RunTaskInput, TaskId, TaskLiveness } from "@edd/core";
import { createDynamoClient, dropTable, dynamodb, ensureTable, makeWorkspaceEntity } from "@edd/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceService } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const TABLE = "ecs-dev-desktop-cp-crash-integ";
const OUTAGE_MESSAGE = "injected DynamoDB write outage";

/** Records every launched/stopped task id while delegating to the fake. */
class TrackingCompute implements ComputeProvider {
  readonly launched: TaskId[] = [];
  readonly stopped: TaskId[] = [];
  constructor(private readonly inner: FakeComputeProvider) {}

  async runTask(input: RunTaskInput): Promise<ComputeTask> {
    const task = await this.inner.runTask(input);
    this.launched.push(task.id);
    return task;
  }

  async stopTask(taskId: TaskId): Promise<void> {
    this.stopped.push(taskId);
    await this.inner.stopTask(taskId);
  }

  taskState(taskId: TaskId): Promise<TaskLiveness> {
    return this.inner.taskState(taskId);
  }
}

describe("crash-consistency: persist failure compensates the launched task", () => {
  const outage = { failWrites: false };
  let client: ReturnType<typeof createDynamoClient>;
  let service: WorkspaceService;
  let compute: TrackingCompute;

  beforeAll(async () => {
    client = createDynamoClient();
    // Writes fail while the outage is armed; reads are untouched. The
    // middleware stack is the AWS SDK's supported extension point.
    client.middlewareStack.add(
      (next, context) => (args) => {
        if (
          outage.failWrites &&
          (context.commandName === "PutItemCommand" || context.commandName === "UpdateItemCommand")
        ) {
          return Promise.reject(new Error(OUTAGE_MESSAGE));
        }
        return next(args);
      },
      { step: "initialize", name: "injectedWriteOutage" },
    );
    await dropTable(client, TABLE);
    await ensureTable(client, TABLE);
  });

  beforeEach(async () => {
    outage.failWrites = false;
    const storage = await FakeStorageProvider.create();
    compute = new TrackingCompute(new FakeComputeProvider(storage));
    service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, TABLE),
      storage,
      compute,
      clock: systemClock,
    });
  });

  afterAll(async () => {
    outage.failWrites = false;
    await dropTable(client, TABLE);
  });

  it("create(): persist failure stops the just-launched task and surfaces the error", async () => {
    outage.failWrites = true;
    await expect(
      service.create({ ownerId: ownerId("crash-a"), baseImage: baseImage("golden/node:20") }),
    ).rejects.toThrow(OUTAGE_MESSAGE);

    expect(compute.launched).toHaveLength(1);
    expect(compute.stopped).toEqual(compute.launched);

    // No half-created record is visible afterwards.
    outage.failWrites = false;
    expect(await service.list({ ownerId: ownerId("crash-a") })).toHaveLength(0);
  });

  it("start(): persist failure stops the just-launched task; the record stays stopped", async () => {
    const ws = await service.create({
      ownerId: ownerId("crash-b"),
      baseImage: baseImage("golden/node:20"),
    });
    const stopRes = await service.stop(workspaceId(ws.id));
    expect(stopRes.ok).toBe(true);
    const launchedBefore = compute.launched.length;

    outage.failWrites = true;
    await expect(service.start(workspaceId(ws.id))).rejects.toThrow(OUTAGE_MESSAGE);
    outage.failWrites = false;

    // Exactly one wake task launched, and it was compensated away.
    expect(compute.launched).toHaveLength(launchedBefore + 1);
    const wakeTask = compute.launched[launchedBefore];
    expect(compute.stopped).toContain(wakeTask);

    // The record still says stopped (untouched), so a retry can succeed.
    const after = await service.get(workspaceId(ws.id));
    expect(after?.state).toBe("stopped");
    const retried = await service.start(workspaceId(ws.id));
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.value.state).toBe("running");
  });
});
