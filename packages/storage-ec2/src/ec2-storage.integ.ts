// SPDX-License-Identifier: AGPL-3.0-or-later
import { awsSim, DEFAULT_AWS_REGION } from "@edd/config";
import { describe, expect, it } from "vitest";

import { Ec2StorageProvider } from "./index";

// Point the AWS SDK at the sockerless AWS simulator (Tier-2 harness, from source).
process.env.AWS_ENDPOINT_URL ??= awsSim.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

describe("Ec2StorageProvider against the sockerless AWS sim", () => {
  const sp = Ec2StorageProvider.fromEnv();

  it("runs the EBS lifecycle: create → snapshot → restore → enumerate → delete", async () => {
    const vol = await sp.createVolume();
    const snap = await sp.createSnapshot(vol.id);

    // The #359 path: hydrate a fresh volume from a completed snapshot.
    const restored = await sp.createVolume({ fromSnapshot: snap.id });
    expect(restored.hydratedFrom).toBe(snap.id);

    const volIds = (await sp.listVolumes()).map((v) => v.id);
    expect(volIds).toContain(vol.id);
    expect(volIds).toContain(restored.id);
    expect((await sp.listSnapshots()).map((s) => s.id)).toContain(snap.id);

    await sp.deleteSnapshot(snap.id);
    await sp.deleteVolume(vol.id);
    await sp.deleteVolume(restored.id);

    expect((await sp.listSnapshots()).map((s) => s.id)).not.toContain(snap.id);
    const afterVols = (await sp.listVolumes()).map((v) => v.id);
    expect(afterVols).not.toContain(vol.id);
    expect(afterVols).not.toContain(restored.id);
  });
});
