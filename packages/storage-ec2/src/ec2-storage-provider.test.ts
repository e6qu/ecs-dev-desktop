// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CreateSnapshotCommand,
  CreateVolumeCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { volumeId } from "@edd/core";
import { describe, expect, it } from "vitest";

import { Ec2StorageProvider } from "./index";

// Pure checks — no AWS calls (constructing a client does no I/O).
describe("Ec2StorageProvider (unit)", () => {
  const sp = new Ec2StorageProvider({ client: new EC2Client({ region: "us-east-1" }) });

  it("defers volume file I/O to the compute layer", () => {
    expect(() => sp.readFile()).toThrow(/compute/);
    expect(() => sp.writeFile()).toThrow(/compute/);
  });
});

describe("Ec2StorageProvider create cleanup on a failed settle", () => {
  /** A client where the created volume never becomes available — DescribeVolumes
   * reports a terminal `deleted` state, so the VolumeAvailable waiter fails fast.
   * Every DeleteVolume is recorded so the test can assert the cleanup. */
  function volumeStuckClient(deletes: string[]): EC2Client {
    const send = (command: unknown): Promise<unknown> => {
      if (command instanceof CreateVolumeCommand) return Promise.resolve({ VolumeId: "vol-stuck" });
      if (command instanceof DescribeVolumesCommand) {
        return Promise.resolve({ Volumes: [{ VolumeId: "vol-stuck", State: "deleted" }] });
      }
      if (command instanceof DeleteVolumeCommand) {
        deletes.push(String(command.input.VolumeId));
        return Promise.resolve({});
      }
      return Promise.reject(new Error("unexpected command"));
    };
    return { send } as unknown as EC2Client;
  }

  /** A client where the created snapshot never completes — DescribeSnapshots reports
   * a terminal `error` state, so the SnapshotCompleted waiter fails fast. */
  function snapshotStuckClient(deletes: string[]): EC2Client {
    const send = (command: unknown): Promise<unknown> => {
      if (command instanceof CreateSnapshotCommand) {
        return Promise.resolve({ SnapshotId: "snap-stuck" });
      }
      if (command instanceof DescribeSnapshotsCommand) {
        return Promise.resolve({ Snapshots: [{ SnapshotId: "snap-stuck", State: "error" }] });
      }
      if (command instanceof DeleteSnapshotCommand) {
        deletes.push(String(command.input.SnapshotId));
        return Promise.resolve({});
      }
      return Promise.reject(new Error("unexpected command"));
    };
    return { send } as unknown as EC2Client;
  }

  it("deletes a volume that never becomes available (no leaked EBS)", async () => {
    const deletes: string[] = [];
    const sp = new Ec2StorageProvider({ client: volumeStuckClient(deletes) });
    await expect(sp.createVolume()).rejects.toThrow();
    expect(deletes).toEqual(["vol-stuck"]);
  });

  it("deletes a snapshot that never completes (no leaked snapshot)", async () => {
    const deletes: string[] = [];
    const sp = new Ec2StorageProvider({ client: snapshotStuckClient(deletes) });
    await expect(sp.createSnapshot(volumeId("vol-source"))).rejects.toThrow();
    expect(deletes).toEqual(["snap-stuck"]);
  });
});
