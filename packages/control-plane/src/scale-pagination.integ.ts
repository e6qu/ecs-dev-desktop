// SPDX-License-Identifier: AGPL-3.0-or-later
// Scale / pagination honesty: a single DynamoDB query or scan page caps at
// 1 MB. `WorkspaceService.list()` must paginate fully — otherwise the per-owner
// list undercounts (a quota BYPASS) and the admin all-list hides workspaces.
// This seeds well past one page and asserts every record is returned.
import {
  FakeComputeProvider,
  FakeStorageProvider,
  ownerId,
  systemClock,
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

import { WorkspaceService } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;

const TABLE = "ecs-dev-desktop-cp-scale-integ";
// >1 MB of items forces multi-page reads (a single DynamoDB page caps at 1 MB).
// 400 records × ~4 KB each ≈ 1.6 MB for one owner — several pages. (With a
// single-page read this owner truncates to ~235, the bug this guards.)
const OWNER_COUNT = 400;
const OWNER = "scale-owner";
// A second owner, to prove the per-owner GSI query is filtered AND paginated.
const OTHER = "other-owner";
const OTHER_COUNT = 50;
// Padding so each record is large enough that the set spans several pages.
const PAD = "x".repeat(4096); // each record > a few KB so the owner set spans multiple 1 MB pages

describe("WorkspaceService.list pagination at scale (DynamoDB Local)", () => {
  let client: ReturnType<typeof createDynamoClient>;
  let service: WorkspaceService;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TABLE);
    await ensureTable(client, TABLE);
    const entity = makeWorkspaceEntity(client, TABLE);
    const storage = await FakeStorageProvider.create();
    // Only list() (a read path) is under test; storage/compute fakes satisfy
    // the constructor and are never exercised by the seed-then-list flow.
    service = new WorkspaceService({
      workspaces: entity,
      storage,
      compute: new FakeComputeProvider(storage),
      clock: systemClock,
    });

    // Seed directly through the entity (fast, and list() is what's under test).
    const at = new Date(0).toISOString();
    const seed = (id: string, owner: string) =>
      entity
        .create({
          id,
          ownerId: owner,
          baseImage: `golden/node:20#${PAD}`,
          state: "running",
          createdAt: at,
          lastActivity: at,
          version: 0,
        })
        .go();

    const batches: Promise<unknown>[] = [];
    for (let i = 0; i < OWNER_COUNT; i++) batches.push(seed(`ws-scale-${String(i)}`, OWNER));
    for (let i = 0; i < OTHER_COUNT; i++) batches.push(seed(`ws-other-${String(i)}`, OTHER));
    await Promise.all(batches);
  });

  afterAll(async () => {
    await dropTable(client, TABLE);
  });

  it("per-owner list returns ALL of one owner's workspaces (quota-count honesty)", async () => {
    const owned = await service.list({ ownerId: ownerId(OWNER) });
    expect(owned).toHaveLength(OWNER_COUNT);
    expect(owned.every((w) => w.ownerId === OWNER)).toBe(true);
  });

  it("admin list returns every owner's workspaces across pages", async () => {
    const all = await service.list();
    expect(all.length).toBe(OWNER_COUNT + OTHER_COUNT);
    const ids = new Set(all.map((w) => workspaceId(w.id)));
    expect(ids.size).toBe(OWNER_COUNT + OTHER_COUNT);
  });
});
