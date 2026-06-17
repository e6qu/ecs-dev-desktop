// SPDX-License-Identifier: AGPL-3.0-or-later
// Real-AWS-only EBS snapshot lifecycle + latency smoke for the manual `e2e-aws`
// tier (run by .github/workflows/e2e-aws.yml). This certifies what no simulator
// can: a real EBS volume → snapshot → restore round-trip on real EC2, plus the
// real snapshot-completion latency.
//
// Coordinates, not targets (AGENTS.md §6.9): it builds the client from the ambient
// env — `AWS_REGION` + the OIDC-provided credentials — with NO endpoint override.
// There is no simulator here; it refuses to run if `AWS_ENDPOINT_URL` is set.
//
// Every resource it creates is tagged with the run prefix, and it deletes its own
// volumes/snapshots in `finally`. The workflow ALSO sweeps the tag on `always()`,
// so a hard crash can't leak resources (cost guardrail).
import {
  CreateSnapshotCommand,
  CreateVolumeCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeAvailabilityZonesCommand,
  DescribeVolumesCommand,
  EC2Client,
  waitUntilSnapshotCompleted,
  waitUntilVolumeAvailable,
  type TagSpecification,
} from "@aws-sdk/client-ec2";

const VOLUME_SIZE_GIB = 8;
const VOLUME_TYPE = "gp3";
const VOLUME_READY_TIMEOUT_S = 120;
const SNAPSHOT_READY_TIMEOUT_S = 900; // real snapshots can take minutes
const RESOURCE_TAG_KEY = "edd-e2eaws-run";

function required<T>(value: T | undefined | null, field: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${field}`);
  return value;
}

function config(): { region: string; prefix: string } {
  const region = process.env.AWS_REGION;
  if (region === undefined || region === "") throw new Error("AWS_REGION is required");
  // Real AWS only — a set endpoint means a simulator, which this tier does not use.
  if (process.env.AWS_ENDPOINT_URL !== undefined && process.env.AWS_ENDPOINT_URL !== "") {
    throw new Error("AWS_ENDPOINT_URL is set; the e2e-aws smoke targets real AWS only");
  }
  return { region, prefix: process.env.EDD_E2E_AWS_PREFIX ?? "edd-e2eaws-local" };
}

async function main(): Promise<void> {
  const { region, prefix } = config();
  const ec2 = new EC2Client({ region });
  const tags = (resourceType: "volume" | "snapshot"): TagSpecification[] => [
    {
      ResourceType: resourceType,
      Tags: [
        { Key: RESOURCE_TAG_KEY, Value: prefix },
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
    const volId = required(
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
    volumes.push(volId);
    await waitUntilVolumeAvailable(
      { client: ec2, maxWaitTime: VOLUME_READY_TIMEOUT_S },
      { VolumeIds: [volId] },
    );

    // 2. Snapshot it — measure the real completion latency a simulator can't model.
    const startedAt = Date.now();
    const snapId = required(
      (
        await ec2.send(
          new CreateSnapshotCommand({ VolumeId: volId, TagSpecifications: tags("snapshot") }),
        )
      ).SnapshotId,
      "SnapshotId",
    );
    snapshots.push(snapId);
    await waitUntilSnapshotCompleted(
      { client: ec2, maxWaitTime: SNAPSHOT_READY_TIMEOUT_S },
      { SnapshotIds: [snapId] },
    );
    console.log(`snapshot ${snapId} reached completed in ${String(Date.now() - startedAt)} ms`);

    // 3. Restore a NEW volume from that snapshot — the scale-to-zero persistence loop.
    const restoredId = required(
      (
        await ec2.send(
          new CreateVolumeCommand({
            AvailabilityZone: az,
            SnapshotId: snapId,
            VolumeType: VOLUME_TYPE,
            TagSpecifications: tags("volume"),
          }),
        )
      ).VolumeId,
      "restored VolumeId",
    );
    volumes.push(restoredId);
    await waitUntilVolumeAvailable(
      { client: ec2, maxWaitTime: VOLUME_READY_TIMEOUT_S },
      { VolumeIds: [restoredId] },
    );

    // 4. Lineage: the restored volume reports the snapshot as its source.
    const source = (await ec2.send(new DescribeVolumesCommand({ VolumeIds: [restoredId] })))
      .Volumes?.[0]?.SnapshotId;
    if (source !== snapId) {
      throw new Error(`restored volume ${restoredId} source ${source ?? "none"} !== ${snapId}`);
    }
    console.log(`OK: EBS snapshot round-trip — restored ${restoredId} from ${snapId}`);
  } finally {
    // Bulletproof teardown: delete everything we created (snapshots first, then the
    // detached volumes), best-effort so one failure doesn't strand the rest.
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

await main();
