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

  it("scopes enumeration to its own managed resources (GC safety)", async () => {
    const a = Ec2StorageProvider.fromEnv({ scope: "edd-itest-scope-a" });
    const b = Ec2StorageProvider.fromEnv({ scope: "edd-itest-scope-b" });

    const volA = await a.createVolume();
    // `a` sees its own volume; `b` (a different scope) never does — so b's GC
    // could never reap a's volume.
    expect((await a.listVolumes()).map((v) => v.id)).toContain(volA.id);
    expect((await b.listVolumes()).map((v) => v.id)).not.toContain(volA.id);

    await a.deleteVolume(volA.id);
  });
});
