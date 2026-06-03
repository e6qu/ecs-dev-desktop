// SPDX-License-Identifier: AGPL-3.0-or-later
import { listWorkspacesResponse, workspace } from "@edd/api-contracts";
import { CatalogService } from "@edd/control-plane";
import { baseImage, systemClock } from "@edd/core";
import {
  createDynamoClient,
  dropTable,
  dynamodbLocal,
  ensureTable,
  makeBaseImageEntity,
} from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEV_AUTH_ENABLED,
  DEV_AUTH_ENV,
  ROLE_HEADER,
  USER_ID_HEADER,
} from "../../../lib/constants";
import { GET, POST } from "./route";

const TEST_TABLE = "ecs-dev-desktop-web-integ";

process.env[DEV_AUTH_ENV] = DEV_AUTH_ENABLED;
process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;
process.env.DYNAMODB_TABLE = TEST_TABLE;

const url = "http://localhost/api/workspaces";
const headers = {
  [USER_ID_HEADER]: "alice",
  [ROLE_HEADER]: "member",
  "content-type": "application/json",
};

describe("workspaces API end-to-end (DynamoDB Local)", () => {
  let client: ReturnType<typeof createDynamoClient>;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
    // Seed the catalog: workspaces may only launch from an enabled entry.
    await new CatalogService({
      baseImages: makeBaseImageEntity(client, TEST_TABLE),
      clock: systemClock,
    }).create({ name: "Node 20", image: baseImage("golden/node:20") });
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("creates (201) then lists the workspace for its owner", async () => {
    const createRes = await POST(
      new Request(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ baseImage: "golden/node:20" }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createdJson: unknown = await createRes.json();
    const ws = workspace.parse(createdJson);
    expect(ws.ownerId).toBe("alice");

    const listRes = await GET(new Request(url, { headers }));
    expect(listRes.status).toBe(200);
    const listJson: unknown = await listRes.json();
    const body = listWorkspacesResponse.parse(listJson);
    expect(body.workspaces.map((w) => w.id)).toContain(ws.id);
  });

  it("rejects creating from an image that is not in the catalog (409)", async () => {
    const res = await POST(
      new Request(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ baseImage: "golden/not-in-catalog:1" }),
      }),
    );
    expect(res.status).toBe(409);
  });
});
