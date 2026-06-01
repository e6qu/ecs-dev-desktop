// SPDX-License-Identifier: AGPL-3.0-or-later
process.env.EDD_DEV_AUTH = "1";
process.env.DYNAMODB_ENDPOINT ??= "http://localhost:8000";
process.env.DYNAMODB_TABLE = "ecs-dev-desktop-web-integ";

import { createDynamoClient, dropTable, ensureTable } from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET, POST } from "./route";

const TABLE = "ecs-dev-desktop-web-integ";
const url = "http://localhost/api/workspaces";
const headers = {
  "x-edd-user-id": "alice",
  "x-edd-role": "member",
  "content-type": "application/json",
};

describe("workspaces API end-to-end (DynamoDB Local)", () => {
  let client: ReturnType<typeof createDynamoClient>;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TABLE);
    await ensureTable(client, TABLE);
  });

  afterAll(async () => {
    if (client) await dropTable(client, TABLE);
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
    const ws = (await createRes.json()) as { id: string; ownerId: string };
    expect(ws.ownerId).toBe("alice");

    const listRes = await GET(new Request(url, { headers }));
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { workspaces: { id: string }[] };
    expect(body.workspaces.map((w) => w.id)).toContain(ws.id);
  });
});
