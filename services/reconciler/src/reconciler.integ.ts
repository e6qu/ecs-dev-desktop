// SPDX-License-Identifier: AGPL-3.0-or-later
import { WorkspaceService } from "@edd/control-plane";
import {
  baseImage,
  FakeComputeProvider,
  FakeStorageProvider,
  ownerId,
  workspaceId,
  type Clock,
} from "@edd/core";
import { createDynamoClient, dropTable, dynamodb, ensureTable, makeWorkspaceEntity } from "@edd/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Reconciler } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const TEST_TABLE = "ecs-dev-desktop-recon-integ";
const THIRTY_MIN = 30 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const T0 = "2026-06-01T00:00:00.000Z";
const LATER = "2026-06-01T02:00:00.000Z"; // 2h after T0

describe("Reconciler", () => {
  let client: ReturnType<typeof createDynamoClient>;

  beforeAll(() => {
    client = createDynamoClient();
  });

  // Each test starts from an empty table so cross-test workspaces don't leak
  // into the reconciler's table-wide scans (GC keep-set, snapshot candidates).
  beforeEach(async () => {
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  /**
   * A service + reconciler sharing ONE storage and ONE clock. The clock starts
   * at T0 (so creation/`createdAt` are in the past) and `advance()` moves it to
   * simulate the reconciler running later — matching production, where the
   * service stamps snapshots at the same wall clock the reconciler decides on.
   */
  async function harness(gcGraceMs = ONE_HOUR) {
    let current = T0;
    const clock: Clock = { now: () => current };
    const storage = await FakeStorageProvider.create(clock);
    const service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, TEST_TABLE),
      storage,
      compute: new FakeComputeProvider(storage),
      clock,
    });
    const reconciler = new Reconciler({
      service,
      storage,
      clock,
      idleThresholdMs: THIRTY_MIN,
      snapshotIntervalMs: THIRTY_MIN,
      gcGraceMs,
    });
    const advance = (iso: string): void => {
      current = iso;
    };
    return { storage, service, reconciler, advance };
  }

  it("scales an idle workspace to zero", async () => {
    const { service, reconciler, advance } = await harness();
    const stale = await service.create({ ownerId: ownerId("alice"), baseImage: baseImage("img") });

    advance(LATER);
    expect((await reconciler.runOnce()).stopped).toBe(1);
    expect((await service.get(workspaceId(stale.id)))?.state).toBe("stopped");
  });

  it("takes a scheduled snapshot of a due running workspace", async () => {
    const { storage, service, reconciler, advance } = await harness();
    await service.create({ ownerId: ownerId("bob"), baseImage: baseImage("img") });

    advance(LATER);
    const before = (await storage.listSnapshots()).length;
    expect(await reconciler.snapshotDue()).toEqual({
      scanned: 1,
      snapshotted: 1,
      skipped: 0,
      failed: 0,
    });
    expect((await storage.listSnapshots()).length).toBe(before + 1);

    // Just snapshotted at "now", it is no longer due on the next pass.
    expect((await reconciler.snapshotDue()).snapshotted).toBe(0);
  });

  it("does not schedule snapshots for terminated workspaces", async () => {
    const { storage, service, reconciler, advance } = await harness();
    const ws = await service.create({ ownerId: ownerId("deleted"), baseImage: baseImage("img") });

    expect((await service.remove(workspaceId(ws.id))).ok).toBe(true);
    expect((await service.finishDeleting(workspaceId(ws.id))).ok).toBe(true);
    expect((await service.get(workspaceId(ws.id)))?.state).toBe("terminated");
    const snapshotCount = (await storage.listSnapshots()).length;

    advance(LATER);
    expect(await reconciler.snapshotDue()).toEqual({
      scanned: 0,
      snapshotted: 0,
      skipped: 0,
      failed: 0,
    });
    expect((await storage.listSnapshots()).length).toBe(snapshotCount);
  });

  it("garbage-collects an orphaned volume, sparing referenced storage", async () => {
    const { storage, service, reconciler, advance } = await harness();
    const live = await service.create({ ownerId: ownerId("carol"), baseImage: baseImage("img") });
    const orphan = await storage.createVolume(); // exists in storage, no workspace refers to it

    advance(LATER); // past the grace window
    const result = await reconciler.collectGarbage();
    expect(result.volumesDeleted).toBe(1);

    const remaining = (await storage.listVolumes()).map((v) => v.id);
    expect(remaining).not.toContain(orphan.id);
    // carol's live workspace still has its volume.
    expect((await service.get(workspaceId(live.id)))?.state).toBe("running");
    expect(remaining.length).toBe(1);
  });

  it("never reaps a freshly-created volume within the grace window (GC vs create TOCTOU)", async () => {
    // GC reads the keep-set, then deletes. A volume created by a concurrent
    // create() between those steps is unreferenced but BRAND NEW; the grace
    // window is what protects it from being reaped out from under the in-flight
    // create. Here the clock does NOT advance, so the orphan is within grace.
    const { storage, reconciler } = await harness(ONE_HOUR);
    const justCreated = await storage.createVolume(); // unreferenced, age ~0

    const result = await reconciler.collectGarbage();
    expect(result.volumesDeleted).toBe(0);
    expect((await storage.listVolumes()).map((v) => v.id)).toContain(justCreated.id);
  });

  it("reaps the snapshot superseded after a stop→start cycle", async () => {
    // grace 0 so the just-superseded snapshot is immediately eligible.
    const { storage, service, reconciler } = await harness(0);
    const ws = await service.create({ ownerId: ownerId("dave"), baseImage: baseImage("img") });

    await service.stop(workspaceId(ws.id)); // snapshot #1 (becomes latest)
    await service.start(workspaceId(ws.id)); // hydrates a new volume from snapshot #1
    await service.snapshot(workspaceId(ws.id)); // snapshot #2 (now latest; #1 unreferenced)

    expect((await storage.listSnapshots()).length).toBe(2);
    const gc = await reconciler.collectGarbage();
    expect(gc.snapshotsDeleted).toBe(1); // only the superseded snapshot #1
    expect((await storage.listSnapshots()).length).toBe(1);
  });

  it("scales to zero across a large stale fleet (paginated sweep honesty)", async () => {
    // listActive() reads every running/idle record via byState (pages:"all").
    // A bare single-page read would cap the sweep at ~1 MB of items, silently
    // leaving most idle workspaces running. Seed well past one page.
    const FLEET = 450;
    const PAD = "x".repeat(2048);
    const { reconciler, advance } = await harness();
    const entity = makeWorkspaceEntity(client, TEST_TABLE);
    await Promise.all(
      Array.from({ length: FLEET }, (_unused, i) =>
        entity
          .create({
            id: `ws-fleet-${String(i)}`,
            ownerId: `fleet-${String(i % 7)}`,
            baseImage: `img#${PAD}`,
            state: "running",
            createdAt: T0,
            lastActivity: T0, // stale relative to LATER
            version: 0,
          })
          .go(),
      ),
    );

    advance(LATER);
    const result = await reconciler.runOnce();
    expect(result.scanned).toBe(FLEET);
    expect(result.stopped).toBe(FLEET);

    // Nothing left running/idle: a second sweep finds an empty active set.
    expect((await reconciler.runOnce()).scanned).toBe(0);
  });
});
