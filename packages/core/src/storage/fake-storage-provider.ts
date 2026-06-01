// SPDX-License-Identifier: AGPL-3.0-or-later
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { newSnapshotId, newVolumeId, type SnapshotId, type VolumeId } from "../domain/ids";
import type { Snapshot, StorageProvider, Volume } from "./storage-provider";

function isFileNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * Filesystem-backed StorageProvider for unit/CI tests. Each volume and snapshot
 * is a directory; a snapshot is a deep copy of the volume tree, and hydrating a
 * volume from a snapshot copies that tree back. This reproduces the snapshot
 * DATA round-trip (not EBS latency/lazy-load — that is the `e2e-aws` tier's job).
 */
export class FakeStorageProvider implements StorageProvider {
  private constructor(private readonly root: string) {}

  static async create(): Promise<FakeStorageProvider> {
    const root = await mkdtemp(join(tmpdir(), "edd-fake-storage-"));
    await mkdir(join(root, "volumes"), { recursive: true });
    await mkdir(join(root, "snapshots"), { recursive: true });
    return new FakeStorageProvider(root);
  }

  private volumeDir(id: VolumeId): string {
    return join(this.root, "volumes", id);
  }

  private snapshotDir(id: SnapshotId): string {
    return join(this.root, "snapshots", id);
  }

  async createVolume(opts?: { fromSnapshot?: SnapshotId }): Promise<Volume> {
    const id = newVolumeId();
    const dir = this.volumeDir(id);
    await mkdir(dir, { recursive: true });
    if (opts?.fromSnapshot) {
      await cp(this.snapshotDir(opts.fromSnapshot), dir, { recursive: true });
    }
    return { id, hydratedFrom: opts?.fromSnapshot };
  }

  async readFile(volumeId: VolumeId, path: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.volumeDir(volumeId), path));
    } catch (err) {
      if (isFileNotFound(err)) return null;
      throw err;
    }
  }

  async writeFile(volumeId: VolumeId, path: string, data: Buffer): Promise<void> {
    const full = join(this.volumeDir(volumeId), path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async createSnapshot(volumeId: VolumeId): Promise<Snapshot> {
    const id = newSnapshotId();
    await cp(this.volumeDir(volumeId), this.snapshotDir(id), { recursive: true });
    return { id, sourceVolumeId: volumeId };
  }

  async deleteVolume(volumeId: VolumeId): Promise<void> {
    await rm(this.volumeDir(volumeId), { recursive: true, force: true });
  }

  /** Test helper: remove the entire on-disk scratch area. */
  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
