// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CopySnapshotCommand,
  CreateSnapshotCommand,
  CreateVolumeCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  EC2Client,
  type CopySnapshotCommandInput,
  type CreateVolumeCommandInput,
  type DescribeSnapshotsCommandInput,
  type DescribeVolumesCommandInput,
} from "@aws-sdk/client-ec2";
import { snapshotId, volumeId } from "@edd/core";
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

// The security-critical guarantee: every resource we create is tagged `edd:managed`
// and every enumeration filters by it, so GC can NEVER touch a resource we didn't
// create. These assert the actual `command.input` (not just that a command was sent),
// so a dropped tag / wrong filter / mis-branched Size↔SnapshotId fails loudly.
describe("Ec2StorageProvider AWS request shape (managed tags + filters + branches)", () => {
  interface Sent {
    name: string;
    input: unknown;
  }

  // A REAL EC2Client (the smithy paginators assert `instanceof EC2Client`) with its
  // `send` swapped for a capturing stub that records every command's input.
  function capturing(sent: Sent[]): EC2Client {
    const client = new EC2Client({ region: "us-east-1" });
    const send = (command: unknown): Promise<unknown> => {
      sent.push({
        name: (command as { constructor: { name: string } }).constructor.name,
        input: (command as { input: unknown }).input,
      });
      const CREATED = new Date("2026-06-01T00:00:00.000Z"); // fixed inert fixture (§6.10)
      if (command instanceof CreateVolumeCommand) return Promise.resolve({ VolumeId: "vol-new" });
      if (command instanceof DescribeVolumesCommand)
        return Promise.resolve({
          Volumes: [{ VolumeId: "vol-new", State: "available", CreateTime: CREATED }],
        });
      if (command instanceof CreateSnapshotCommand)
        return Promise.resolve({ SnapshotId: "snap-new" });
      if (command instanceof DescribeSnapshotsCommand)
        return Promise.resolve({
          Snapshots: [
            { SnapshotId: "snap-new", State: "completed", StartTime: CREATED, VolumeId: "vol-new" },
          ],
        });
      if (command instanceof CopySnapshotCommand)
        return Promise.resolve({ SnapshotId: "snap-copy" });
      if (command instanceof DeleteVolumeCommand || command instanceof DeleteSnapshotCommand)
        return Promise.resolve({});
      return Promise.reject(
        new Error(`unexpected ${(command as { constructor: { name: string } }).constructor.name}`),
      );
    };
    (client as unknown as { send: typeof send }).send = send;
    return client;
  }

  function inputOf(sent: Sent[], name: string): unknown {
    const found = sent.find((s) => s.name === name);
    if (found === undefined) throw new Error(`no ${name} issued`);
    return found.input;
  }

  const MANAGED = { Key: "edd:managed", Value: "true" };

  it("tags a fresh volume edd:managed=true and sizes it (no SnapshotId)", async () => {
    const sent: Sent[] = [];
    const sp = new Ec2StorageProvider({ client: capturing(sent), region: "us-east-1" });
    await sp.createVolume();
    const input = inputOf(sent, "CreateVolumeCommand") as CreateVolumeCommandInput;
    expect(input.AvailabilityZone).toBe("us-east-1a");
    expect(input.Size).toBeGreaterThan(0);
    expect(input.SnapshotId).toBeUndefined();
    expect(input.TagSpecifications?.[0]?.Tags).toContainEqual(MANAGED);
  });

  it("hydrates from a snapshot (SnapshotId set, no Size) and tags it managed", async () => {
    const sent: Sent[] = [];
    const sp = new Ec2StorageProvider({ client: capturing(sent), region: "us-east-1" });
    const vol = await sp.createVolume({ fromSnapshot: snapshotId("snap-src") });
    expect(vol.hydratedFrom).toBe("snap-src");
    const input = inputOf(sent, "CreateVolumeCommand") as CreateVolumeCommandInput;
    expect(input.SnapshotId).toBe("snap-src");
    expect(input.Size).toBeUndefined();
    expect(input.TagSpecifications?.[0]?.Tags).toContainEqual(MANAGED);
  });

  it("scopes enumeration with server-side tag filters (+ OwnerIds:self for snapshots)", async () => {
    const sent: Sent[] = [];
    const sp = new Ec2StorageProvider({
      client: capturing(sent),
      region: "us-east-1",
      scope: "team-a",
    });
    await sp.listVolumes();
    await sp.listSnapshots();
    const vf = inputOf(sent, "DescribeVolumesCommand") as DescribeVolumesCommandInput;
    expect(vf.Filters).toContainEqual({ Name: "tag:edd:managed", Values: ["true"] });
    expect(vf.Filters).toContainEqual({ Name: "tag:edd:scope", Values: ["team-a"] });
    const sf = inputOf(sent, "DescribeSnapshotsCommand") as DescribeSnapshotsCommandInput;
    expect(sf.OwnerIds).toEqual(["self"]); // without it real AWS returns every public snapshot
    expect(sf.Filters).toContainEqual({ Name: "tag:edd:managed", Values: ["true"] });
  });

  it("copySnapshot issues against the destination region, naming the source region + id", async () => {
    const srcSent: Sent[] = [];
    const destSent: Sent[] = [];
    const dest = capturing(destSent);
    const sp = new Ec2StorageProvider({
      client: capturing(srcSent),
      region: "us-east-1",
      clientForRegion: () => dest,
    });
    expect(await sp.copySnapshot(snapshotId("snap-src"), "us-west-2")).toBe("snap-copy");
    // The copy must be issued on the DESTINATION client, not the source.
    expect(srcSent.some((s) => s.name === "CopySnapshotCommand")).toBe(false);
    const input = inputOf(destSent, "CopySnapshotCommand") as CopySnapshotCommandInput;
    expect(input.SourceRegion).toBe("us-east-1");
    expect(input.SourceSnapshotId).toBe("snap-src");
    expect(input.TagSpecifications?.[0]?.Tags).toContainEqual(MANAGED);
  });
});
