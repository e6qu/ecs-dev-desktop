// SPDX-License-Identifier: AGPL-3.0-or-later
// Whole-fleet workspace reads go through the state index, never a table scan.
// The table holds every entity; on 2026-09-14 the dev stack's held 7,432 items
// for 4 workspaces, and the admin list's scan took 32 s. This seeds a workspace
// in every state beside a crowd of unrelated session rows, then records the
// DynamoDB commands each fleet read sends.
import {
  FakeComputeProvider,
  FakeStorageProvider,
  systemClock,
  WORKSPACE_STATES,
} from "@edd/core";
import {
  createDynamoClient,
  dropTable,
  dynamodb,
  ensureTable,
  makeAuthSessionEntity,
  makeWorkspaceEntity,
} from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DerivedAuditSource } from "./audit-source";
import { WorkspaceService } from "./index";

process.env.AWS_ENDPOINT_URL ??= dynamodb.endpoint;

const TABLE = "ecs-dev-desktop-cp-state-index-integ";
const UNRELATED_SESSIONS = 200;

describe("whole-fleet workspace reads (DynamoDB)", () => {
  const commands: string[] = [];
  let client: ReturnType<typeof createDynamoClient>;
  let service: WorkspaceService;
  let audit: DerivedAuditSource;
  const seeded: string[] = [];

  beforeAll(async () => {
    client = createDynamoClient();
    client.middlewareStack.add(
      (next, context) => (args) => {
        commands.push(String(context.commandName));
        return next(args);
      },
      { step: "initialize", name: "recordCommandNames" },
    );
    await dropTable(client, TABLE);
    await ensureTable(client, TABLE);
    const workspaces = makeWorkspaceEntity(client, TABLE);
    const sessions = makeAuthSessionEntity(client, TABLE);
    const storage = await FakeStorageProvider.create();
    service = new WorkspaceService({
      workspaces,
      storage,
      compute: new FakeComputeProvider(storage),
      clock: systemClock,
    });
    audit = new DerivedAuditSource({ workspaces });

    const at = new Date(0).toISOString();
    await Promise.all(
      WORKSPACE_STATES.map((state) => {
        const id = `ws-state-index-${state}`;
        seeded.push(id);
        return workspaces
          .create({
            id,
            ownerId: "state-index-owner",
            baseImage: "golden/node:20",
            resources: { cpuUnits: 512, memoryMiB: 2048, volumeGiB: 8 },
            state,
            createdAt: at,
            lastActivity: at,
            version: 0,
          })
          .go();
      }),
    );
    const expires = new Date(Date.now() + 3_600_000);
    await Promise.all(
      Array.from({ length: UNRELATED_SESSIONS }, (_, i) =>
        sessions
          .create({
            id: `unrelated-session-${String(i)}`,
            schemaVersion: 3,
            ownerId: "someone-else",
            role: "developer",
            provider: "credentials",
            providerSubject: "someone-else",
            providerSessionId: `unrelated-session-${String(i)}`,
            createdAt: at,
            refreshedAt: at,
            expiresAt: expires.toISOString(),
            expiresAtEpochSeconds: Math.floor(expires.getTime() / 1000),
          })
          .go(),
      ),
    );
  });

  afterAll(async () => {
    await dropTable(client, TABLE);
  });

  it("returns a workspace in every state from the admin list", async () => {
    const listed = await service.list();
    expect(listed.map((w) => w.id).sort()).toEqual([...seeded].sort());
  });

  it("never scans the table for the list, the reconciler keep-sets or the audit feed", async () => {
    commands.length = 0;
    await service.list();
    await service.listReferencedStorage();
    await service.listFleetReferences();
    await service.listReferencedTasks();
    await service.listRuntimeSecretWorkspaceIds();
    await audit.recent();
    expect(commands.filter((name) => name.includes("Scan"))).toEqual([]);
    expect(commands.some((name) => name.includes("Query"))).toBe(true);
  });
});
