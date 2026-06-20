// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import type { StorageProvider } from "./storage-provider";

/** Options for {@link storageProviderContract}. */
export interface StorageContractOptions {
  /**
   * Whether the provider supports volume **file** I/O (`readFile`/`writeFile`).
   * The real `Ec2StorageProvider` cannot read or write EBS *contents* over the
   * EC2 API — a volume's bytes are only reachable by attaching it to a running
   * task (AGENTS.md §6.8), so those cases are validated through the compute layer
   * and the real-AWS tier. Pass `dataIo: false` to run the **control-plane
   * subset** (volume/snapshot lifecycle + snapshot-hydration lineage) that every
   * provider — fake or real EBS — must satisfy over the standard API. Default
   * `true` (the fake exercises the full suite, file I/O included).
   */
  dataIo?: boolean;
}

/**
 * Reusable contract. Every StorageProvider implementation (fake, sockerless,
 * real EBS) must pass this identical suite — that is what keeps the fake honest
 * against the real adapters. The data-fidelity cases require volume file I/O and
 * so run only where it is expressible (`dataIo: true`, the default); the
 * lifecycle + hydration-lineage cases run everywhere, including the real EC2 tier
 * (`dataIo: false`).
 */
export function storageProviderContract(
  name: string,
  makeProvider: () => Promise<StorageProvider>,
  { dataIo = true }: StorageContractOptions = {},
): void {
  describe(`StorageProvider contract: ${name}`, () => {
    if (dataIo) {
      it("round-trips data through a snapshot (write → snapshot → hydrate → read)", async () => {
        const sp = await makeProvider();

        const source = await sp.createVolume();
        await sp.writeFile(source.id, "project/main.ts", Buffer.from("hello"));

        const snap = await sp.createSnapshot(source.id);
        const restored = await sp.createVolume({ fromSnapshot: snap.id });

        const bytes = await sp.readFile(restored.id, "project/main.ts");
        expect(bytes?.toString()).toBe("hello");
      });

      it("isolates writes made after a snapshot from the snapshot", async () => {
        const sp = await makeProvider();
        const v = await sp.createVolume();
        await sp.writeFile(v.id, "a.txt", Buffer.from("1"));
        const snap = await sp.createSnapshot(v.id);

        // Mutate the source AFTER snapshotting.
        await sp.writeFile(v.id, "a.txt", Buffer.from("2"));

        const restored = await sp.createVolume({ fromSnapshot: snap.id });
        const bytes = await sp.readFile(restored.id, "a.txt");
        expect(bytes?.toString()).toBe("1");
      });

      it("returns null for an absent file", async () => {
        const sp = await makeProvider();
        const v = await sp.createVolume();
        expect(await sp.readFile(v.id, "missing")).toBeNull();
      });
    }

    it("records a restored volume's snapshot lineage (hydratedFrom)", async () => {
      const sp = await makeProvider();
      const v = await sp.createVolume();
      const snap = await sp.createSnapshot(v.id);
      expect(snap.sourceVolumeId).toBe(v.id);

      const restored = await sp.createVolume({ fromSnapshot: snap.id });
      expect(restored.hydratedFrom).toBe(snap.id);
    });

    it("enumerates volumes and snapshots, dropping deleted ones", async () => {
      const sp = await makeProvider();
      const v = await sp.createVolume();
      const snap = await sp.createSnapshot(v.id);

      expect((await sp.listVolumes()).map((x) => x.id)).toContain(v.id);
      expect((await sp.listSnapshots()).map((x) => x.id)).toContain(snap.id);

      await sp.deleteVolume(v.id);
      await sp.deleteSnapshot(snap.id);

      expect((await sp.listVolumes()).map((x) => x.id)).not.toContain(v.id);
      expect((await sp.listSnapshots()).map((x) => x.id)).not.toContain(snap.id);
    });
  });
}
