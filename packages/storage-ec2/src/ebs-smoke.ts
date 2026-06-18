// SPDX-License-Identifier: AGPL-3.0-or-later
// The EBS snapshot lifecycle round-trip, as a standalone function over a supplied
// EC2 client. Used two ways by coordinates alone (AGENTS.md §6.9): the storage
// integ tier runs it against the sockerless AWS sim (validating the logic + the
// `finally` teardown), and the manual `e2e-aws` tier runs it against REAL AWS via
// `packages/e2e/src/aws-ebs-smoke.ts`, where it additionally measures the real
// snapshot-completion latency no simulator can model.
import {
  CreateSnapshotCommand,
  CreateVolumeCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeAvailabilityZonesCommand,
  DescribeVolumesCommand,
  type EC2Client,
  type TagSpecification,
  waitUntilSnapshotCompleted,
  waitUntilVolumeAvailable,
} from "@aws-sdk/client-ec2";

const VOLUME_SIZE_GIB = 8;
const VOLUME_TYPE = "gp3";
const VOLUME_READY_TIMEOUT_S = 120;
const SNAPSHOT_READY_TIMEOUT_S = 900; // real snapshots can take minutes
/** Tag key on every resource the smoke creates, so the e2e-aws workflow can sweep
 * leftovers on `always()` (and a test can verify teardown). */
export const EBS_SMOKE_TAG_KEY = "edd-e2eaws-run";

function required<T>(value: T | undefined | null, field: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${field}`);
  return value;
}

export interface EbsSmokeResult {
  readonly sourceVolumeId: string;
  readonly snapshotId: string;
  readonly restoredVolumeId: string;
  /** Wall-clock ms from CreateSnapshot to the snapshot reaching `completed`. */
  readonly snapshotLatencyMs: number;
}

/**
 * Create a gp3 volume → snapshot it (timing completion) → restore a NEW volume from
 * the snapshot → assert the restored volume's lineage points at the snapshot. Every
 * resource is tagged with `prefix`; all of them are deleted in `finally` (snapshots
 * first, then the detached volumes), best-effort so one failure can't strand the rest.
 */
export async function runEbsSmoke(ec2: EC2Client, prefix: string): Promise<EbsSmokeResult> {
  const tags = (resourceType: "volume" | "snapshot"): TagSpecification[] => [
    {
      ResourceType: resourceType,
      Tags: [
        { Key: EBS_SMOKE_TAG_KEY, Value: prefix },
        { Key: "Name", Value: prefix },
      ],
    },
  ];

  const az = required(
    (
      await ec2.send(
        new DescribeAvailabilityZonesCommand({
          Filters: [{ Name: "state", Values: ["available"] }],
        }),
      )
    ).AvailabilityZones?.[0]?.ZoneName,
    "an available AZ",
  );

  const volumes: string[] = [];
  const snapshots: string[] = [];
  try {
    // 1. A fresh gp3 volume (the unit of workspace state).
    const sourceVolumeId = required(
      (
        await ec2.send(
          new CreateVolumeCommand({
            AvailabilityZone: az,
            Size: VOLUME_SIZE_GIB,
            VolumeType: VOLUME_TYPE,
            TagSpecifications: tags("volume"),
          }),
        )
      ).VolumeId,
      "VolumeId",
    );
    volumes.push(sourceVolumeId);
    await waitUntilVolumeAvailable(
      { client: ec2, maxWaitTime: VOLUME_READY_TIMEOUT_S },
      { VolumeIds: [sourceVolumeId] },
    );

    // 2. Snapshot it — time the completion (a sim can't model real latency).
    const startedAt = Date.now();
    const snapshotId = required(
      (
        await ec2.send(
          new CreateSnapshotCommand({
            VolumeId: sourceVolumeId,
            TagSpecifications: tags("snapshot"),
          }),
        )
      ).SnapshotId,
      "SnapshotId",
    );
    snapshots.push(snapshotId);
    await waitUntilSnapshotCompleted(
      { client: ec2, maxWaitTime: SNAPSHOT_READY_TIMEOUT_S },
      { SnapshotIds: [snapshotId] },
    );
    const snapshotLatencyMs = Date.now() - startedAt;

    // 3. Restore a NEW volume from the snapshot — the scale-to-zero persistence loop.
    const restoredVolumeId = required(
      (
        await ec2.send(
          new CreateVolumeCommand({
            AvailabilityZone: az,
            SnapshotId: snapshotId,
            VolumeType: VOLUME_TYPE,
            TagSpecifications: tags("volume"),
          }),
        )
      ).VolumeId,
      "restored VolumeId",
    );
    volumes.push(restoredVolumeId);
    await waitUntilVolumeAvailable(
      { client: ec2, maxWaitTime: VOLUME_READY_TIMEOUT_S },
      { VolumeIds: [restoredVolumeId] },
    );

    // 4. Lineage: the restored volume reports the snapshot as its source.
    const source = (await ec2.send(new DescribeVolumesCommand({ VolumeIds: [restoredVolumeId] })))
      .Volumes?.[0]?.SnapshotId;
    if (source !== snapshotId) {
      throw new Error(
        `restored volume ${restoredVolumeId} source ${source ?? "none"} !== ${snapshotId}`,
      );
    }
    return { sourceVolumeId, snapshotId, restoredVolumeId, snapshotLatencyMs };
  } finally {
    for (const id of snapshots) {
      await ec2.send(new DeleteSnapshotCommand({ SnapshotId: id })).catch((e: unknown) => {
        console.error(`teardown snapshot ${id}: ${String(e)}`);
      });
    }
    for (const id of volumes) {
      await ec2.send(new DeleteVolumeCommand({ VolumeId: id })).catch((e: unknown) => {
        console.error(`teardown volume ${id}: ${String(e)}`);
      });
    }
  }
}
