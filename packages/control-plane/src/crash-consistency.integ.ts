// SPDX-License-Identifier: AGPL-3.0-or-later
// Crash-consistency under DynamoDB write outages, injected through the AWS SDK's
// public middleware stack (writes fail, reads pass) so the whole real persistence
// path up to DynamoDB is exercised:
//   • create() launches then persists — a persist failure must stop the task.
//   • start() is CLAIM-BEFORE-LAUNCH: the provisioning claim is persisted FIRST,
//     so a write failure there leaks nothing (no task launched yet); a failure on
//     the post-launch COMMIT must stop the task AND roll the claim back to stopped.
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

/** Records every launched/stopped task id while delegating to the fake. An
 * optional `afterLaunch` hook lets a test arm an outage AFTER the task launches
 * (to fail the post-launch commit write specifically). */
class TrackingCompute implements ComputeProvider {
  readonly launched: TaskId[] = [];
  readonly stopped: TaskId[] = [];
  afterLaunch?: () => void;
  constructor(private readonly inner: FakeComputeProvider) {}

  async runTask(input: RunTaskInput): Promise<ComputeTask> {
    const task = await this.inner.runTask(input);
    this.launched.push(task.id);
    this.afterLaunch?.();
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
  // `failWrites` fails every write while armed; `failNextWrites` fails the next N
  // writes then disarms (to fail a specific write, e.g. the post-launch commit).
  const outage = { failWrites: false, failNextWrites: 0 };
  let client: ReturnType<typeof createDynamoClient>;
  let service: WorkspaceService;
  let compute: TrackingCompute;

  beforeAll(async () => {
    client = createDynamoClient();
    // Writes fail while the outage is armed; reads are untouched. The
    // middleware stack is the AWS SDK's supported extension point.
    client.middlewareStack.add(
      (next, context) => (args) => {
        const isWrite =
          context.commandName === "PutItemCommand" || context.commandName === "UpdateItemCommand";
        if (isWrite && (outage.failWrites || outage.failNextWrites > 0)) {
          if (outage.failNextWrites > 0) outage.failNextWrites -= 1;
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
    outage.failNextWrites = 0;
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
    outage.failNextWrites = 0;
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

  it("start(): a write outage on the claim launches NO task and keeps the record stopped", async () => {
    const ws = await service.create({
      ownerId: ownerId("crash-b"),
      baseImage: baseImage("golden/node:20"),
    });
    expect((await service.stop(workspaceId(ws.id))).ok).toBe(true);
    const launchedBefore = compute.launched.length;

    outage.failWrites = true;
    await expect(service.start(workspaceId(ws.id))).rejects.toThrow(OUTAGE_MESSAGE);
    outage.failWrites = false;

    // Claim-before-launch: the provisioning claim write failed BEFORE any launch,
    // so nothing was started and nothing leaked.
    expect(compute.launched).toHaveLength(launchedBefore);

    // The record still says stopped (untouched), so a retry can succeed.
    const after = await service.get(workspaceId(ws.id));
    expect(after?.state).toBe("stopped");
    const retried = await service.start(workspaceId(ws.id));
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.value.state).toBe("running");
  });

  it("start(): a write outage on the post-launch commit stops the task and rolls back to stopped", async () => {
    const ws = await service.create({
      ownerId: ownerId("crash-c"),
      baseImage: baseImage("golden/node:20"),
    });
    expect((await service.stop(workspaceId(ws.id))).ok).toBe(true);
    const launchedBefore = compute.launched.length;

    // Claim write succeeds; the task launches; then arm a one-shot outage so the
    // commit (provisioning → running) write fails. The rollback write then succeeds.
    compute.afterLaunch = () => {
      outage.failNextWrites = 1;
    };
    await expect(service.start(workspaceId(ws.id))).rejects.toThrow(OUTAGE_MESSAGE);
    compute.afterLaunch = undefined;

    // Exactly one wake task launched, and it was compensated away.
    expect(compute.launched).toHaveLength(launchedBefore + 1);
    const wakeTask = compute.launched[launchedBefore];
    expect(compute.stopped).toContain(wakeTask);

    // The claim was rolled back, so the workspace is wake-able again.
    const after = await service.get(workspaceId(ws.id));
    expect(after?.state).toBe("stopped");
    const retried = await service.start(workspaceId(ws.id));
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.value.state).toBe("running");
  });

  it("recoverStuckProvisioning reverts a wake stranded in provisioning (commit + rollback both failed)", async () => {
    const ws = await service.create({
      ownerId: ownerId("crash-d"),
      baseImage: baseImage("golden/node:20"),
    });
    expect((await service.stop(workspaceId(ws.id))).ok).toBe(true);

    // The task launches; then fail ALL writes so BOTH the commit (provisioning →
    // running) AND the rollback fail — leaving the record stranded in provisioning,
    // exactly as a crashed/evicted process would.
    compute.afterLaunch = () => {
      outage.failWrites = true;
    };
    await expect(service.start(workspaceId(ws.id))).rejects.toThrow(OUTAGE_MESSAGE);
    compute.afterLaunch = undefined;
    outage.failWrites = false;

    // Stranded in provisioning — no other sweep would ever touch it.
    expect((await service.get(workspaceId(ws.id)))?.state).toBe("provisioning");

    // Self-healing: recover it back to stopped (its snapshot is preserved, so it is
    // wake-able again).
    expect((await service.recoverStuckProvisioning(workspaceId(ws.id))).ok).toBe(true);
    expect((await service.get(workspaceId(ws.id)))?.state).toBe("stopped");

    const retried = await service.start(workspaceId(ws.id));
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.value.state).toBe("running");
  });
});
