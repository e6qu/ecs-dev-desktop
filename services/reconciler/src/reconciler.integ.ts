// SPDX-License-Identifier: AGPL-3.0-or-later
import { WorkspaceService } from "@edd/control-plane";
import {
  baseImage,
  FakeComputeProvider,
  FakeStorageProvider,
  fixedClock,
  ownerId,
  workspaceId,
} from "@edd/core";
import {
  createDynamoClient,
  dropTable,
  dynamodbLocal,
  ensureTable,
  makeWorkspaceEntity,
} from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Reconciler } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;

const TEST_TABLE = "ecs-dev-desktop-recon-integ";
const THIRTY_MIN = 30 * 60 * 1000;

describe("Reconciler against DynamoDB Local", () => {
  let client: ReturnType<typeof createDynamoClient>;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("scales an idle workspace to zero, leaving a fresh one running", async () => {
    const service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, TEST_TABLE),
      storage: await FakeStorageProvider.create(),
      compute: new FakeComputeProvider(),
      clock: fixedClock("2026-06-01T00:00:00.000Z"),
    });

    const stale = await service.create({ ownerId: ownerId("alice"), baseImage: baseImage("img") });

    // The reconciler's clock is one hour ahead of the workspace's last activity.
    const reconciler = new Reconciler({
      service,
      clock: fixedClock("2026-06-01T01:00:00.000Z"),
      idleThresholdMs: THIRTY_MIN,
    });

    const result = await reconciler.runOnce();
    expect(result.stopped).toBe(1);

    const after = await service.get(workspaceId(stale.id));
    expect(after?.state).toBe("stopped");
  });
});
