// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { Entity } from "electrodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDynamoClient,
  dropTable,
  dynamodb,
  ensureTable,
  makeCostRollupEntity,
  makeWorkspaceEntity,
} from "./index";

// Tier-2: runs against the configured DynamoDB endpoint (the sockerless sim in CI; §6.9).
process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const TEST_TABLE = "ecs-dev-desktop-integ";

describe("@edd/db ElectroDB against the configured DynamoDB endpoint", () => {
  let client: DynamoDBClient;
  let workspaces: ReturnType<typeof makeWorkspaceEntity>;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
    workspaces = makeWorkspaceEntity(client, TEST_TABLE);
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("puts and reads back a workspace", async () => {
    await workspaces
      .put({
        id: "ws-1",
        ownerId: "alice",
        baseImage: "golden/node:20",
        resources: { cpuUnits: 512, memoryMiB: 2048, volumeGiB: 8 },
        state: "running",
        lastActivity: "2026-06-01T10:00:00.000Z",
        createdAt: "2026-06-01T09:00:00.000Z",
      })
      .go();

    const { data } = await workspaces.get({ id: "ws-1" }).go();
    expect(data?.ownerId).toBe("alice");
    expect(data?.state).toBe("running");
  });

  it("lists a user's workspaces via GSI1 (byOwner)", async () => {
    await workspaces
      .put({
        id: "ws-2",
        ownerId: "alice",
        baseImage: "golden/go:1.22",
        resources: { cpuUnits: 512, memoryMiB: 2048, volumeGiB: 8 },
        state: "idle",
        lastActivity: "2026-06-01T11:00:00.000Z",
        createdAt: "2026-06-01T09:30:00.000Z",
      })
      .go();

    const { data } = await workspaces.query.byOwner({ ownerId: "alice" }).go();
    expect(data.map((w) => w.id).sort()).toEqual(["ws-1", "ws-2"]);
  });

  it("finds idle workspaces via GSI2 (byState) for the reconciler", async () => {
    const { data } = await workspaces.query.byState({ state: "idle" }).go();
    expect(data.some((w) => w.id === "ws-2")).toBe(true);
    expect(data.every((w) => w.state === "idle")).toBe(true);
  });

  it("does not read incompatible version-1 cost rollups as current checkpoints", async () => {
    const legacy = new Entity(
      {
        model: { entity: "costRollup", version: "1", service: "edd" },
        attributes: {
          workspaceId: { type: "string", required: true },
          owner: { type: "string", required: true },
          checkpointAt: { type: "string", required: true },
        },
        indexes: {
          primary: {
            pk: { field: "PK", composite: ["workspaceId"] },
            sk: { field: "SK", composite: [] },
          },
          byAll: {
            index: "GSI1",
            pk: { field: "GSI1PK", composite: [] },
            sk: { field: "GSI1SK", composite: ["workspaceId"] },
          },
        },
      },
      { client, table: TEST_TABLE },
    );
    await legacy
      .put({
        workspaceId: "ws-legacy-rollup",
        owner: "alice",
        checkpointAt: "2026-06-01T12:00:00.000Z",
      })
      .go();

    const current = makeCostRollupEntity(client, TEST_TABLE);
    const { data } = await current.query.byAll({}).go({ pages: "all" });
    expect(data.some((row) => row.workspaceId === "ws-legacy-rollup")).toBe(false);
  });
});
