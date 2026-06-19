// SPDX-License-Identifier: AGPL-3.0-or-later
import { aws, DEFAULT_AWS_REGION } from "@edd/config";
import { describe, expect, it } from "vitest";

import { Ec2StorageProvider } from "./index";

// Point the AWS SDK at the sockerless AWS simulator (Tier-2 harness, from source).
process.env.AWS_ENDPOINT_URL ??= aws.endpoint;
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

  it("runs the cross-region DR flow: snapshot → CopySnapshot → restore from the copy", async () => {
    // Disaster recovery: a workspace snapshot is copied to another region, from which
    // a fresh volume can be hydrated. The sim serves any region from one endpoint, so
    // the "destination region" is nominal here, but the standard CopySnapshot →
    // restore path is exercised end to end (sockerless#602). Real cross-region
    // durability/latency is the e2e-aws tier; this proves the API flow + lineage.
    const vol = await sp.createVolume();
    const snap = await sp.createSnapshot(vol.id);

    const copyId = await sp.copySnapshot(snap.id, "us-west-2");
    expect(copyId).not.toBe(snap.id); // a new, independent snapshot
    expect((await sp.listSnapshots()).map((s) => s.id)).toContain(copyId);

    // Restore (hydrate) a fresh volume from the DR copy — the recovery step.
    const recovered = await sp.createVolume({ fromSnapshot: copyId });
    expect(recovered.hydratedFrom).toBe(copyId);

    await sp.deleteVolume(recovered.id);
    await sp.deleteSnapshot(copyId);
    await sp.deleteSnapshot(snap.id);
    await sp.deleteVolume(vol.id);
  });

  it("runs a multi-generation snapshot chain (repeated scale-to-zero persistence)", async () => {
    // Scale-to-zero persists a workspace as an EBS snapshot, then hydrates a fresh
    // volume from it on wake — over and over. Each cycle snapshots a volume that
    // was ITSELF hydrated from the previous generation's snapshot. This probes that
    // the cloud tracks snapshot→source lineage across generations (not collapsing
    // back to the original volume) and that restoring from a snapshot whose source
    // was a restored volume works — the real persistence loop over many idle cycles.
    const gen0 = await sp.createVolume();
    const snap0 = await sp.createSnapshot(gen0.id);
    expect(snap0.sourceVolumeId).toBe(gen0.id);

    // Wake 1: hydrate gen1 from gen0's snapshot, then stop → snapshot gen1.
    const gen1 = await sp.createVolume({ fromSnapshot: snap0.id });
    expect(gen1.hydratedFrom).toBe(snap0.id);
    const snap1 = await sp.createSnapshot(gen1.id);
    expect(snap1.id).not.toBe(snap0.id);
    // Lineage tracks the RESTORED volume, not the original.
    expect(snap1.sourceVolumeId).toBe(gen1.id);

    // Wake 2: hydrate gen2 from gen1's snapshot — i.e. restore from a snapshot
    // whose source was itself a restored volume.
    const gen2 = await sp.createVolume({ fromSnapshot: snap1.id });
    expect(gen2.hydratedFrom).toBe(snap1.id);

    // Enumeration reflects both snapshots with their correct per-generation source.
    const sources = new Map((await sp.listSnapshots()).map((s) => [s.id, s.sourceVolumeId]));
    expect(sources.get(snap0.id)).toBe(gen0.id);
    expect(sources.get(snap1.id)).toBe(gen1.id);

    await sp.deleteSnapshot(snap0.id);
    await sp.deleteSnapshot(snap1.id);
    await sp.deleteVolume(gen0.id);
    await sp.deleteVolume(gen1.id);
    await sp.deleteVolume(gen2.id);
  });

  it("reports ok when the EC2 control plane is reachable (live health check)", async () => {
    const health = await sp.health();
    expect(health.component).toBe("storage");
    expect(health.status).toBe("ok");
    expect(health.detail).toContain("AZ");
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
