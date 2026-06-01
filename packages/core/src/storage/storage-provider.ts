// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SnapshotId, VolumeId } from "../domain/ids";

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

export interface StorageProvider {
  createVolume(opts?: { fromSnapshot?: SnapshotId }): Promise<Volume>;
  readFile(volumeId: VolumeId, path: string): Promise<Buffer | null>;
  writeFile(volumeId: VolumeId, path: string, data: Buffer): Promise<void>;
  createSnapshot(volumeId: VolumeId): Promise<Snapshot>;
  deleteVolume(volumeId: VolumeId): Promise<void>;
}
