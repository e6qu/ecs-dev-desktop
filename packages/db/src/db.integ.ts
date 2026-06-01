// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDynamoClient,
  dropTable,
  dynamodbLocal,
  ensureTable,
  makeWorkspaceEntity,
} from "./index";

// Tier-2: runs against DynamoDB Local (docker-compose.tier2.yml / CI service).
process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;

const TEST_TABLE = "ecs-dev-desktop-integ";

describe("@edd/db ElectroDB against DynamoDB Local", () => {
  let client: DynamoDBClient;
  let workspaces: ReturnType<typeof makeWorkspaceEntity>;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
    workspaces = makeWorkspaceEntity(client, TEST_TABLE);
  });

  afterAll(async () => {
    if (client) await dropTable(client, TEST_TABLE);
  });

  it("puts and reads back a workspace", async () => {
    await workspaces
      .put({
        id: "ws-1",
        ownerId: "alice",
        baseImage: "golden/node:20",
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
});
