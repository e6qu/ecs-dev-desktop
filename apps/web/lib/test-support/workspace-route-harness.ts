// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared harness for the workspace route integration tests.
// One source for the DB lifecycle + dev-auth wiring + request helpers, so each
// route's *.integ.ts stays focused on its own assertions (and jscpd stays quiet).
import { workspace } from "@edd/api-contracts";
import { CatalogService } from "@edd/control-plane";
import { baseImage, systemClock, workspaceId } from "@edd/core";
import { createDynamoClient, dropTable, dynamodb, ensureTable, makeBaseImageEntity } from "@edd/db";
import { afterAll, beforeAll, expect } from "vitest";

import { POST as createWorkspace } from "../../app/api/workspaces/route";
import { DEV_AUTH_ENABLED, DEV_AUTH_ENV, ROLE_HEADER, USER_ID_HEADER } from "../constants";
import { getControlPlane } from "../control-plane";

const NODE_IMAGE = "golden/node:20";

/** Base URL of the workspaces collection (route handlers ignore the host). */
export const apiBase = "http://localhost/api/workspaces";

/** Dev-auth headers identifying `id` as a `member` (gated on `EDD_DEV_AUTH`). */
export const member = (id: string) => ({
  [USER_ID_HEADER]: id,
  [ROLE_HEADER]: "member",
  "content-type": "application/json",
});

/** Dev-auth headers identifying `id` as an `admin` (gated on `EDD_DEV_AUTH`). */
export const admin = (id: string) => ({
  [USER_ID_HEADER]: id,
  [ROLE_HEADER]: "admin",
  "content-type": "application/json",
});

/** The Next.js route context (`{ params }`) for a `[id]` dynamic segment. */
export const routeCtx = (id: string) => ({ params: Promise.resolve({ id }) });

type LifecycleHandler = (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

/** Invoke a body-less lifecycle route (`start`/`stop`/`snapshot`/`connect`) as `actor`. */
export function postLifecycle(
  handler: LifecycleHandler,
  segment: string,
  actor: string,
  id: string,
): Promise<Response> {
  return handler(
    new Request(`${apiBase}/${id}/${segment}`, { method: "POST", headers: member(actor) }),
    routeCtx(id),
  );
}

/**
 * Point the web app at the sim's DynamoDB + a per-suite table with dev-auth on, and
 * register the create/drop + golden-image seed around the suite. Call once at the
 * top level of a `*.integ.ts` file (it wires vitest `beforeAll`/`afterAll`).
 */
export function useWorkspaceTable(table: string): void {
  process.env[DEV_AUTH_ENV] = DEV_AUTH_ENABLED;
  process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;
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

/**
 * Create a RUNNING workspace owned by `owner` via the real create route; returns
 * its id. The create route reserves the record and returns instantly (state
 * `provisioning`) while the launch runs detached, so this fixture awaits
 * `launchReserved` to drive it to `running` deterministically before the caller
 * acts on it — idempotent with the route's own detached launch (whichever binds
 * the task first wins; the other is a no-op). Without this every lifecycle test
 * would race the async launch and see a `provisioning` workspace.
 */
export async function createWorkspaceFor(owner: string): Promise<string> {
  const res = await createWorkspace(
    new Request(apiBase, {
      method: "POST",
      headers: member(owner),
      body: JSON.stringify({ baseImage: NODE_IMAGE }),
    }),
  );
  expect(res.status).toBe(201);
  const id = workspace.parse(await res.json()).id;
  // Instant create returns a `provisioning` record while the route launches
  // compute detached. Drive it to `running` deterministically before returning:
  // `launchReserved` is idempotent, so this either performs the launch or (if the
  // route's detached launch already won) returns a no-op success. On the rare
  // version-race conflict the detached launch is binding the task — confirm the
  // workspace reaches `running` rather than double-launching. In the sim this is
  // sub-millisecond; the bound just guards against a hang.
  const cp = await getControlPlane();
  const wsId = workspaceId(id);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await cp.get(wsId);
    if (current?.state === "running") return id;
    await cp.launchReserved(wsId);
  }
  throw new Error(`workspace ${id} did not reach running within the launch budget`);
}
