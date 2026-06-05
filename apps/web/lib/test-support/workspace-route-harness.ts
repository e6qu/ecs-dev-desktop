// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared harness for the workspace route integration tests (DynamoDB Local).
// One source for the DB lifecycle + dev-auth wiring + request helpers, so each
// route's *.integ.ts stays focused on its own assertions (and jscpd stays quiet).
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
import { afterAll, beforeAll, expect } from "vitest";

import { POST as createWorkspace } from "../../app/api/workspaces/route";
import { DEV_AUTH_ENABLED, DEV_AUTH_ENV, ROLE_HEADER, USER_ID_HEADER } from "../constants";

const NODE_IMAGE = "golden/node:20";

/** Base URL of the workspaces collection (route handlers ignore the host). */
export const apiBase = "http://localhost/api/workspaces";

/** Dev-auth headers identifying `id` as a `member` (gated on `EDD_DEV_AUTH`). */
export const member = (id: string) => ({
  [USER_ID_HEADER]: id,
  [ROLE_HEADER]: "member",
  "content-type": "application/json",
});

/** The Next.js route context (`{ params }`) for a `[id]` dynamic segment. */
export const routeCtx = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * Point the web app at DynamoDB Local + a per-suite table with dev-auth on, and
 * register the create/drop + golden-image seed around the suite. Call once at the
 * top level of a `*.integ.ts` file (it wires vitest `beforeAll`/`afterAll`).
 */
export function useWorkspaceTable(table: string): void {
  process.env[DEV_AUTH_ENV] = DEV_AUTH_ENABLED;
  process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;
  process.env.DYNAMODB_TABLE = table;

  let client: ReturnType<typeof createDynamoClient>;
  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, table);
    await ensureTable(client, table);
    await new CatalogService({
      baseImages: makeBaseImageEntity(client, table),
      clock: systemClock,
    }).create({ name: "Node 20", image: baseImage(NODE_IMAGE) });
  });
  afterAll(async () => {
    await dropTable(client, table);
  });
}

/** Create a workspace owned by `owner` via the real create route; returns its id. */
export async function createWorkspaceFor(owner: string): Promise<string> {
  const res = await createWorkspace(
    new Request(apiBase, {
      method: "POST",
      headers: member(owner),
      body: JSON.stringify({ baseImage: NODE_IMAGE }),
    }),
  );
  expect(res.status).toBe(201);
  return workspace.parse(await res.json()).id;
}
