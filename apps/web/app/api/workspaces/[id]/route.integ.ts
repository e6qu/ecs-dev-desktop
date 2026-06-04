// SPDX-License-Identifier: AGPL-3.0-or-later
import { workspace } from "@edd/api-contracts";
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
} from "../../../../lib/constants";
import { POST as createWorkspace } from "../route";
import { DELETE } from "./route";

const TEST_TABLE = "ecs-dev-desktop-web-id-integ";

process.env[DEV_AUTH_ENV] = DEV_AUTH_ENABLED;
process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;
process.env.DYNAMODB_TABLE = TEST_TABLE;

const NODE_IMAGE = "golden/node:20";
const base = "http://localhost/api/workspaces";
const member = (id: string) => ({
  [USER_ID_HEADER]: id,
  [ROLE_HEADER]: "member",
  "content-type": "application/json",
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function createFor(owner: string): Promise<string> {
  const res = await createWorkspace(
    new Request(base, {
      method: "POST",
      headers: member(owner),
      body: JSON.stringify({ baseImage: NODE_IMAGE }),
    }),
  );
  expect(res.status).toBe(201);
  return workspace.parse(await res.json()).id;
}

function del(actor: string, id: string): Promise<Response> {
  return DELETE(
    new Request(`${base}/${id}`, { method: "DELETE", headers: member(actor) }),
    ctx(id),
  );
}

describe("DELETE /api/workspaces/:id (DynamoDB Local)", () => {
  let client: ReturnType<typeof createDynamoClient>;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
    await new CatalogService({
      baseImages: makeBaseImageEntity(client, TEST_TABLE),
      clock: systemClock,
    }).create({ name: "Node 20", image: baseImage(NODE_IMAGE) });
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("deletes an owned workspace (204)", async () => {
    const id = await createFor("alice");
    expect((await del("alice", id)).status).toBe(204);
  });

  it("returns 404 (not 500) on a repeated delete", async () => {
    const id = await createFor("alice");
    expect((await del("alice", id)).status).toBe(204);
    // A sequential repeat hits the not-found guard (404). The added try/catch
    // additionally maps the *concurrent* race — where both requests pass the
    // guard and the second's re-fetch in cp.remove throws WorkspaceNotFoundError
    // — to 404 as well, so neither path can escape as a 500.
    expect((await del("alice", id)).status).toBe(404);
  });

  it("forbids deleting another member's workspace (403)", async () => {
    const id = await createFor("alice");
    expect((await del("bob", id)).status).toBe(403);
  });
});
