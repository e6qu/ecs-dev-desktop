// SPDX-License-Identifier: AGPL-3.0-or-later
// Cost depends on an EXACT lifecycle ledger: every billable transition must be
// recorded once and only once, and a transition that loses a version race must
// leave NO event behind. WorkspaceService writes each lifecycle event in the
// SAME DynamoDB transaction as the transition, so the two can never diverge.
// Proven here against DynamoDB Local (the version CAS + transaction live at the
// DB boundary, so fakes for storage/compute exercise them faithfully).
import {
  baseImage,
  FakeComputeProvider,
  FakeStorageProvider,
  ownerId,
  systemClock,
  workspaceId,
  type AuditEvent,
} from "@edd/core";
import {
  createDynamoClient,
  dropTable,
  dynamodb,
  ensureTable,
  makeAuditEventEntity,
  makeWorkspaceEntity,
} from "@edd/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { StoredAuditSource, WorkspaceService } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const TABLE = "ecs-dev-desktop-cp-ledger-atomicity-integ";

describe("lifecycle audit ledger is exact (atomic with the transition)", () => {
  let client: ReturnType<typeof createDynamoClient>;
  let service: WorkspaceService;
  let audit: StoredAuditSource;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TABLE);
    await ensureTable(client, TABLE);
  });

  beforeEach(async () => {
    const storage = await FakeStorageProvider.create();
    const events = makeAuditEventEntity(client, TABLE);
    service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, TABLE),
      storage,
      compute: new FakeComputeProvider(storage),
      clock: systemClock,
      audit: events,
    });
    audit = new StoredAuditSource({ events, clock: systemClock });
  });

  afterAll(async () => {
    await dropTable(client, TABLE);
  });

  const running = async (owner: string): Promise<string> =>
    (await service.create({ ownerId: ownerId(owner), baseImage: baseImage("golden/node:20") })).id;

  const eventsFor = async (id: string, action: string): Promise<AuditEvent[]> =>
    (await audit.all()).filter((e) => e.action === action && e.target === id);

  it("writes session.create atomically with the new workspace record", async () => {
    const id = await running("atom-a");
    expect(await eventsFor(id, "session.create")).toHaveLength(1);
  });

  it("a stop that LOSES a version race writes no session.stop event", async () => {
    const id = await running("atom-b");
    // stop vs snapshot: one wins the version CAS. If snapshot wins, stop returns a
    // conflict — and must NOT have written a session.stop. The event count must
    // exactly track whether stop committed.
    const [stop] = await Promise.all([
      service.stop(workspaceId(id)),
      service.snapshot(workspaceId(id)),
    ]);
    const stopEvents = await eventsFor(id, "session.stop");
    expect(stopEvents).toHaveLength(stop.ok ? 1 : 0);
  });

  it("two concurrent stops write exactly one session.stop event (no double-write)", async () => {
    const id = await running("atom-c");
    await Promise.all([service.stop(workspaceId(id)), service.stop(workspaceId(id))]);
    expect(await eventsFor(id, "session.stop")).toHaveLength(1);
  });

  it("retains the full ledger after the workspace is deleted (deleted sessions still price)", async () => {
    const id = await running("atom-d");
    expect((await service.stop(workspaceId(id))).ok).toBe(true);
    // remove() tombstones (records session.delete = the delete request atomically);
    // finishDeleting removes the record AND records session.terminated (teardown
    // complete, ends billing). The append-only events outlive the record.
    expect((await service.remove(workspaceId(id))).ok).toBe(true);
    expect((await service.finishDeleting(workspaceId(id))).ok).toBe(true);
    expect(await service.get(workspaceId(id))).toBeNull();
    expect(await eventsFor(id, "session.create")).toHaveLength(1);
    expect(await eventsFor(id, "session.stop")).toHaveLength(1);
    expect(await eventsFor(id, "session.delete")).toHaveLength(1);
    expect(await eventsFor(id, "session.terminated")).toHaveLength(1);
  });
});
