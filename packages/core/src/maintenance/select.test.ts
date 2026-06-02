// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isoTimestamp, snapshotId, volumeId, workspaceId } from "../domain/ids";
import type { SnapshotRef, VolumeRef } from "../storage/storage-provider";
import {
  selectDueForSnapshot,
  selectOrphanSnapshots,
  selectOrphanVolumes,
  type SnapshotCandidate,
} from "./select";

const now = isoTimestamp("2026-06-01T12:00:00.000Z");
const old = isoTimestamp("2026-06-01T00:00:00.000Z"); // 12h before now
const recent = isoTimestamp("2026-06-01T11:59:00.000Z"); // 1m before now
const ONE_HOUR = 60 * 60 * 1000;

describe("selectOrphanVolumes", () => {
  it("reaps unreferenced volumes past the grace window only", () => {
    const existing: VolumeRef[] = [
      { id: volumeId("vol-referenced"), createdAt: old },
      { id: volumeId("vol-orphan-old"), createdAt: old },
      { id: volumeId("vol-orphan-fresh"), createdAt: recent },
    ];
    const referenced = new Set([volumeId("vol-referenced")]);

    expect(selectOrphanVolumes(existing, referenced, now, ONE_HOUR)).toEqual([
      volumeId("vol-orphan-old"),
    ]);
  });

  it("never reaps a referenced volume even when old", () => {
    const existing: VolumeRef[] = [{ id: volumeId("vol-1"), createdAt: old }];
    expect(selectOrphanVolumes(existing, new Set([volumeId("vol-1")]), now, ONE_HOUR)).toEqual([]);
  });
});

describe("selectOrphanSnapshots", () => {
  it("reaps unreferenced snapshots past the grace window only", () => {
    const existing: SnapshotRef[] = [
      { id: snapshotId("snap-latest"), createdAt: old, sourceVolumeId: volumeId("vol-1") },
      { id: snapshotId("snap-superseded"), createdAt: old, sourceVolumeId: volumeId("vol-1") },
      { id: snapshotId("snap-fresh"), createdAt: recent, sourceVolumeId: volumeId("vol-1") },
    ];
    const referenced = new Set([snapshotId("snap-latest")]);

    expect(selectOrphanSnapshots(existing, referenced, now, ONE_HOUR)).toEqual([
      snapshotId("snap-superseded"),
    ]);
  });
});

describe("selectDueForSnapshot", () => {
  it("selects workspaces never snapshotted or snapshotted before the interval", () => {
    const candidates: SnapshotCandidate[] = [
      { id: workspaceId("ws-never") },
      { id: workspaceId("ws-stale"), latestSnapshotAt: old },
      { id: workspaceId("ws-fresh"), latestSnapshotAt: recent },
    ];

    expect(selectDueForSnapshot(candidates, now, ONE_HOUR)).toEqual([
      workspaceId("ws-never"),
      workspaceId("ws-stale"),
    ]);
  });
});
