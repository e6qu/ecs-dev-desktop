// SPDX-License-Identifier: AGPL-3.0-or-later
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { systemClock, type Clock } from "../clock";
import {
  isoTimestamp,
  newSnapshotId,
  newVolumeId,
  type IsoTimestamp,
  type SnapshotId,
  type VolumeId,
} from "../domain/ids";
import type { Snapshot, SnapshotRef, StorageProvider, Volume, VolumeRef } from "./storage-provider";

function isFileNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * Filesystem-backed StorageProvider for unit/CI tests. Each volume and snapshot
 * is a directory; a snapshot is a deep copy of the volume tree, and hydrating a
 * volume from a snapshot copies that tree back. This reproduces the snapshot
 * DATA round-trip (not EBS latency/lazy-load — that is the `e2e-aws` tier's job).
 *
 * Creation timestamps (stamped from the injected {@link Clock}) and enumeration
 * (`listVolumes`/`listSnapshots`) back the orphan-GC logic the same way
 * `DescribeVolumes`/`DescribeSnapshots` do against real EBS.
 */
export class FakeStorageProvider implements StorageProvider {
  private readonly volumes = new Map<VolumeId, IsoTimestamp>();
  private readonly snapshots = new Map<SnapshotId, { createdAt: IsoTimestamp; source: VolumeId }>();

  private constructor(
    private readonly root: string,
    private readonly clock: Clock,
  ) {}

  static async create(clock: Clock = systemClock): Promise<FakeStorageProvider> {
    const root = await mkdtemp(join(tmpdir(), "edd-fake-storage-"));
    await mkdir(join(root, "volumes"), { recursive: true });
    await mkdir(join(root, "snapshots"), { recursive: true });
    return new FakeStorageProvider(root, clock);
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
    this.volumes.set(id, isoTimestamp(this.clock.now()));
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
    this.snapshots.set(id, { createdAt: isoTimestamp(this.clock.now()), source: volumeId });
    return { id, sourceVolumeId: volumeId };
  }

  async deleteVolume(volumeId: VolumeId): Promise<void> {
    await rm(this.volumeDir(volumeId), { recursive: true, force: true });
    this.volumes.delete(volumeId);
  }

  async deleteSnapshot(snapshotId: SnapshotId): Promise<void> {
    await rm(this.snapshotDir(snapshotId), { recursive: true, force: true });
    this.snapshots.delete(snapshotId);
  }

  listVolumes(): Promise<readonly VolumeRef[]> {
    return Promise.resolve([...this.volumes].map(([id, createdAt]) => ({ id, createdAt })));
  }

  listSnapshots(): Promise<readonly SnapshotRef[]> {
    return Promise.resolve(
      [...this.snapshots].map(([id, meta]) => ({
        id,
        createdAt: meta.createdAt,
        sourceVolumeId: meta.source,
      })),
    );
  }

  /** Test helper: remove the entire on-disk scratch area. */
  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
