// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * StorageProvider — the port that abstracts a workspace's persistent volume and
 * its snapshots. This is the seam that lets us TDD the
 * stateful + snapshottable + scale-to-zero behaviour without real AWS:
 *
 *   - a filesystem-backed FAKE (see {@link FakeStorageProvider}) for unit/CI
 *   - a sockerless-backed adapter once it implements EBS snapshots (issue #347)
 *   - a real EBS adapter, certified by the manual `e2e-aws` tier
 *
 * The contract every implementation MUST honour is the snapshot round-trip:
 * bytes written to a volume must be present on a volume created from a snapshot
 * of that volume. See `storage-provider-contract.test.ts`.
 */

export type VolumeId = string;
export type SnapshotId = string;

export interface Volume {
  readonly id: VolumeId;
  /** SnapshotId this volume was hydrated from, if any. */
  readonly hydratedFrom?: SnapshotId;
}

export interface Snapshot {
  readonly id: SnapshotId;
  readonly sourceVolumeId: VolumeId;
}

export interface StorageProvider {
  /** Create a volume, optionally hydrated from a snapshot. */
  createVolume(opts?: { fromSnapshot?: SnapshotId }): Promise<Volume>;

  /** Read a file's bytes from a volume; returns null if absent. */
  readFile(volumeId: VolumeId, path: string): Promise<Buffer | null>;

  /** Write bytes to a file on a volume (creates parent dirs as needed). */
  writeFile(volumeId: VolumeId, path: string, data: Buffer): Promise<void>;

  /** Capture a point-in-time snapshot of a volume. */
  createSnapshot(volumeId: VolumeId): Promise<Snapshot>;

  /** Permanently delete a volume and its data. */
  deleteVolume(volumeId: VolumeId): Promise<void>;
}
