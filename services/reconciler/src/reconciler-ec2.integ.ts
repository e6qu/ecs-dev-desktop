// SPDX-License-Identifier: AGPL-3.0-or-later
import { awsSim, DEFAULT_AWS_REGION } from "@edd/config";
import { WorkspaceService } from "@edd/control-plane";
import { baseImage, FakeComputeProvider, ownerId, systemClock } from "@edd/core";
import {
  createDynamoClient,
  dropTable,
  dynamodbLocal,
  ensureTable,
  makeWorkspaceEntity,
} from "@edd/db";
import { Ec2StorageProvider } from "@edd/storage-ec2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Reconciler } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;
process.env.AWS_ENDPOINT_URL ??= awsSim.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

const TEST_TABLE = "ecs-dev-desktop-recon-ec2-integ";
// Unique scope so GC here only ever sees this suite's sim resources — never the
// other integ suites sharing the simulator.
const SCOPE = "edd-recon-gc-itest";

/** Remove any scoped sim resources left by a prior (crashed) run. */
async function cleanScope(storage: Ec2StorageProvider): Promise<void> {
  for (const s of await storage.listSnapshots()) await storage.deleteSnapshot(s.id);
  for (const v of await storage.listVolumes()) await storage.deleteVolume(v.id);
}

describe("Reconciler GC against the sim via Ec2StorageProvider", () => {
  let client: ReturnType<typeof createDynamoClient>;

  beforeAll(() => {
    client = createDynamoClient();
  });

  beforeEach(async () => {
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
    await cleanScope(Ec2StorageProvider.fromEnv({ scope: SCOPE }));
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
    await cleanScope(Ec2StorageProvider.fromEnv({ scope: SCOPE }));
  });

  it("reaps orphaned managed volumes/snapshots, sparing referenced ones", async () => {
    const storage = Ec2StorageProvider.fromEnv({ scope: SCOPE });
    const service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, TEST_TABLE),
      storage,
      compute: new FakeComputeProvider(),
      clock: systemClock,
    });
    const reconciler = new Reconciler({ service, storage, clock: systemClock, gcGraceMs: 0 });

    // A live workspace → one referenced (scoped, managed) EBS volume in the sim.
    await service.create({ ownerId: ownerId("gc"), baseImage: baseImage("img") });
    const liveVolumes = (await storage.listVolumes()).map((v) => v.id);
    expect(liveVolumes).toHaveLength(1);

    // Orphans: a volume + snapshot the control plane never records.
    const orphanVol = await storage.createVolume();
    const orphanSnap = await storage.createSnapshot(orphanVol.id);

    const result = await reconciler.collectGarbage();
    expect(result).toEqual({ volumesDeleted: 1, snapshotsDeleted: 1 });

    // The live workspace's volume survives; the orphans are gone.
    expect((await storage.listVolumes()).map((v) => v.id)).toEqual(liveVolumes);
    expect((await storage.listSnapshots()).map((s) => s.id)).not.toContain(orphanSnap.id);
  });
});
