// SPDX-License-Identifier: AGPL-3.0-or-later
// The cost rollup is a PERFORMANCE optimization that must NOT change the figures.
// This proves it against DynamoDB Local: for the same ledger, the rollup report
// (price each workspace by resuming its persisted checkpoint + replaying only the
// events since it) is byte-identical to the full-ledger scan — across a checkpoint
// that falls mid-open-interval, a teardown+terminate after the checkpoint, a
// workspace whose retention window spans it, one undeleted+rewoken after it, one
// purged before it, an unpriceable legacy session (unpriced in both paths), and a
// workspace born after it (the recent-only path).
import type { WorkspaceDto } from "@edd/api-contracts";
import { workspacePricing } from "@edd/config";
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
const RESOURCES = { cpuUnits: 512, memoryMiB: 2048, volumeGiB: 8 } as const;
const RESOURCE_DETAIL = "resources cpuUnits=512 memoryMiB=2048 volumeGiB=8; blank session";
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
      resources: RESOURCES,
      state: "stopped",
      createdAt: isoTimestamp(at(0)),
      availableActions: [],
    },
    {
      id: "ws-c",
      ownerId: "bob",
      baseImage: "golden/node:20",
      resources: RESOURCES,
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
        detail: action === "session.create" ? RESOURCE_DETAIL : "",
        ...(action === "session.create" ? { resources: RESOURCES } : {}),
      })
      .go();
  }

  /** A legacy session.create WITHOUT structured resources — unpriceable, and it
   * must degrade to an `unpriced` report line (never fail the rollup/report). */
  async function seedLegacyCreate(h: number, target: string, actor: string): Promise<void> {
    await makeAuditEventEntity(client, TABLE)
      .put({
        id: `evt-${target}-session.create-${String(h)}`,
        at: at(h),
        actor,
        action: "session.create",
        target,
        detail: "blank session",
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
    await seed("session.create", 0.5, "ws-b", "alice"); // running, torn down AFTER checkpoint
    await seed("session.delete", 5, "ws-b", "alice"); // teardown opens (after checkpoint)
    await seed("session.terminated", 5.5, "ws-b", "alice"); // teardown ends (after checkpoint)
    await seed("session.create", 0, "ws-d", "bob"); // teardown spans + terminates BEFORE checkpoint
    await seed("session.delete", 1, "ws-d", "bob"); // teardown opens at h=1
    await seed("session.terminated", 2, "ws-d", "bob"); // terminated h=2: retention spans the checkpoint
    await seed("session.create", 0, "ws-e", "alice"); // terminated pre-checkpoint, UNDELETED after
    await seed("session.delete", 0.5, "ws-e", "alice");
    await seed("session.terminated", 1, "ws-e", "alice"); // retention opens at h=1
    await seed("session.create", 0, "ws-f", "bob"); // terminated AND purged before the checkpoint
    await seed("session.delete", 1, "ws-f", "bob");
    await seed("session.terminated", 1.5, "ws-f", "bob");
    await seed("session.purged", 2.5, "ws-f", "bob"); // billing permanently ended at h=2.5
    await seedLegacyCreate(0.25, "ws-legacy", "carol"); // unpriceable in BOTH paths

    // Generate the checkpoint as of h=3 (prices only events ≤ h=3).
    nowValue = at(3);
    await new CostService({
      audit,
      workspaces: workspaceSource,
      clock,
      pricing: PRICING,
      rollups: rollupStore,
    }).rollup();

    // A workspace born AFTER the checkpoint → exercises the recent-only path.
    await seed("session.create", 4, "ws-c", "bob");
    // ws-e is restored + rewoken AFTER the checkpoint: the resume must continue
    // its retained-snapshot billing into stopped time and re-bill compute.
    await seed("session.undelete", 4, "ws-e", "alice");
    await seed("session.start", 4.5, "ws-e", "alice");
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
    });
    const fromRollup = new CostService({
      audit,
      workspaces: workspaceSource,
      clock,
      pricing: PRICING,
      rollups: rollupStore,
    });

    const a = await fullScan.report();
    const b = await fromRollup.report();
    expect(b).toEqual(a);
    // Sanity: the report actually priced the six workspaces (not an empty match),
    // and the unpriceable legacy session degraded to an `unpriced` line in BOTH.
    expect(a.bySession).toHaveLength(6);
    expect(a.total.totalUsd).toBeGreaterThan(0);
    expect(a.unpriced.map((u) => u.workspaceId)).toEqual(["ws-legacy"]);
    // The undeleted workspace re-billed compute after its post-checkpoint rewake.
    const e = a.bySession.find((s) => s.workspaceId === "ws-e");
    expect(e?.terminated).toBe(false);
    expect(e?.runningMs).toBe(2 * HOUR); // 0→0.5 pre-delete + 4.5→6 post-undelete
    // The purged workspace stopped billing at the purge (1h retention, none since).
    const f = a.bySession.find((s) => s.workspaceId === "ws-f");
    expect(f?.terminated).toBe(true);
    expect(f?.stoppedMs).toBe(HOUR); // retention h=1.5→2.5 only
  });
});
