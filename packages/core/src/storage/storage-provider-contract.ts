// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import type { StorageProvider } from "./storage-provider";

/**
 * Reusable contract. Every StorageProvider implementation (fake, sockerless,
 * real EBS) must pass this identical suite — that is what keeps the fake honest
 * against the real adapters.
 */
export function storageProviderContract(
  name: string,
  makeProvider: () => Promise<StorageProvider>,
): void {
  describe(`StorageProvider contract: ${name}`, () => {
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
