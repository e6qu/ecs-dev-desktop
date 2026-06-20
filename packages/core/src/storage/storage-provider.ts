// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IsoTimestamp, SnapshotId, VolumeId } from "../domain/ids";
import type { ComponentHealth } from "../observability/health";

/**
 * StorageProvider — the port abstracting a workspace's persistent volume and its
 * snapshots. Implementations: a filesystem FAKE for unit/CI, a sockerless-backed
 * adapter (once #347 lands), and real EBS (certified by the manual `e2e-aws`
 * tier). The contract every implementation honours is the snapshot round-trip
 * (see `storage-provider-contract.ts`).
 */
export interface Volume {
  readonly id: VolumeId;
  /** Snapshot this volume was hydrated from, if any. */
  readonly hydratedFrom?: SnapshotId;
}

export interface Snapshot {
  readonly id: SnapshotId;
  readonly sourceVolumeId: VolumeId;
}

/** A volume as enumerated by the provider (the `DescribeVolumes` projection). */
export interface VolumeRef {
  readonly id: VolumeId;
  readonly createdAt: IsoTimestamp;
}

/** A snapshot as enumerated by the provider (the `DescribeSnapshots` projection). */
export interface SnapshotRef {
  readonly id: SnapshotId;
  readonly createdAt: IsoTimestamp;
  readonly sourceVolumeId: VolumeId;
  /** Marked retained (the data-safety snapshot kept past delete per the Middle
   * policy). Orphan-GC must keep these regardless of the grace window. */
  readonly retained?: boolean;
}

export interface StorageProvider {
  createVolume(opts?: { fromSnapshot?: SnapshotId }): Promise<Volume>;
  readFile(volumeId: VolumeId, path: string): Promise<Buffer | null>;
  writeFile(volumeId: VolumeId, path: string, data: Buffer): Promise<void>;
  /** Snapshot a volume. `retain: true` tags the snapshot as a data-safety keep
   * (the Middle policy's final snapshot at teardown) so orphan-GC never reaps it. */
  createSnapshot(volumeId: VolumeId, opts?: { retain?: boolean }): Promise<Snapshot>;
  /** Mark an existing snapshot retained — used when a workspace being torn down has
   * no live volume to re-snapshot but a prior snapshot already holds its data. */
  tagSnapshotRetained(snapshotId: SnapshotId): Promise<void>;
  deleteVolume(volumeId: VolumeId): Promise<void>;
  deleteSnapshot(snapshotId: SnapshotId): Promise<void>;
  /** Enumerate existing volumes (for orphan GC). */
  listVolumes(): Promise<readonly VolumeRef[]>;
  /** Enumerate existing snapshots (for orphan GC). */
  listSnapshots(): Promise<readonly SnapshotRef[]>;
  /** Copy a snapshot to another region for disaster recovery (snapshot → copy →
   * restore-in-region), returning the new snapshot id. Optional — absent ⇒ no
   * cross-region DR (a backend without copy support). */
  copySnapshot?(snapshotId: SnapshotId, destinationRegion: string): Promise<SnapshotId>;
  /** Dependency health (admin Health board). Real adapters do a live check; absent
   * ⇒ reported as `unknown` (real check available on AWS). */
  health?(): Promise<ComponentHealth>;
}
