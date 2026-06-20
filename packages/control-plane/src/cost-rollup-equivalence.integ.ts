// SPDX-License-Identifier: AGPL-3.0-or-later
// The cost rollup is a PERFORMANCE optimization that must NOT change the figures.
// This proves it against DynamoDB Local: for the same ledger, the rollup report
// (price each workspace by resuming its persisted checkpoint + replaying only the
// events since it) is byte-identical to the full-ledger scan — across a checkpoint
// that falls mid-open-interval, a terminate after the checkpoint, a workspace
// terminated before it, and a workspace born after it (the recent-only path).
import type { WorkspaceDto } from "@edd/api-contracts";
import { workspacePricing, workspaceSizing } from "@edd/config";
import { isoTimestamp, type Clock } from "@edd/core";
import {
  createDynamoClient,
  dropTable,
  dynamodb,
  ensureTable,
  makeAuditEventEntity,
  makeCostRollupEntity,
} from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CostService, StoredAuditSource, StoredCostRollupStore } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const TABLE = "ecs-dev-desktop-cp-cost-rollup-equiv-integ";
const PRICING = workspacePricing();
const SIZING = workspaceSizing();
const EPOCH = Date.parse("2026-06-01T00:00:00.000Z");
const HOUR = 3_600_000;
const at = (h: number) => new Date(EPOCH + h * HOUR).toISOString();

describe("cost rollup report == full-scan report (figure-equivalence)", () => {
  let client: ReturnType<typeof createDynamoClient>;
  let audit: StoredAuditSource;
  let rollupStore: StoredCostRollupStore;
  let nowValue = at(6);
  const clock: Clock = { now: () => isoTimestamp(nowValue) };
  // Current workspace records (some sessions are deleted → absent here).
  const workspaces: WorkspaceDto[] = [
    {
      id: "ws-a",
      ownerId: "alice",
      baseImage: "golden/node:20",
      state: "stopped",
      createdAt: isoTimestamp(at(0)),
      availableActions: [],
    },
    {
      id: "ws-c",
      ownerId: "bob",
      baseImage: "golden/node:20",
      state: "running",
      createdAt: isoTimestamp(at(4)),
      availableActions: [],
    },
  ];
  const workspaceSource = { list: () => Promise.resolve(workspaces) };

  async function seed(action: string, h: number, target: string, actor: string): Promise<void> {
    await makeAuditEventEntity(client, TABLE)
      .put({
        id: `evt-${target}-${action}-${String(h)}`,
        at: at(h),
        actor,
        action,
        target,
        detail: "",
      })
      .go();
  }

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TABLE);
    await ensureTable(client, TABLE);
    audit = new StoredAuditSource({ events: makeAuditEventEntity(client, TABLE), clock });
    rollupStore = new StoredCostRollupStore(makeCostRollupEntity(client, TABLE));

    // Pre-checkpoint lifecycles (all events exist before the rollup at h=3).
    await seed("session.create", 0, "ws-a", "alice"); // running, will stop AFTER checkpoint
    await seed("session.stop", 1, "ws-a", "alice");
    await seed("session.start", 2, "ws-a", "alice"); // open running interval spans h=3
    await seed("session.stop", 4, "ws-a", "alice"); // (after checkpoint)
    await seed("session.create", 0.5, "ws-b", "alice"); // running, deleted AFTER checkpoint
    await seed("session.delete", 5, "ws-b", "alice"); // (after checkpoint)
    await seed("session.create", 0, "ws-d", "bob"); // terminated BEFORE checkpoint
    await seed("session.delete", 1, "ws-d", "bob");

    // Generate the checkpoint as of h=3 (prices only events ≤ h=3).
    nowValue = at(3);
    await new CostService({
      audit,
      workspaces: workspaceSource,
      clock,
      pricing: PRICING,
      sizing: SIZING,
      rollups: rollupStore,
    }).rollup();

    // A workspace born AFTER the checkpoint → exercises the recent-only path.
    await seed("session.create", 4, "ws-c", "bob");
  });

  afterAll(async () => {
    await dropTable(client, TABLE);
  });

  it("prices identically at h=6 whether from the rollup or the full ledger", async () => {
    nowValue = at(6);
    const fullScan = new CostService({
      audit,
      workspaces: workspaceSource,
      clock,
      pricing: PRICING,
      sizing: SIZING,
    });
    const fromRollup = new CostService({
      audit,
      workspaces: workspaceSource,
      clock,
      pricing: PRICING,
      sizing: SIZING,
      rollups: rollupStore,
    });

    const a = await fullScan.report();
    const b = await fromRollup.report();
    expect(b).toEqual(a);
    // Sanity: the report actually priced the four workspaces (not an empty match).
    expect(a.bySession).toHaveLength(4);
    expect(a.total.totalUsd).toBeGreaterThan(0);
  });
});
