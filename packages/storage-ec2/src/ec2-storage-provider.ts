// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CreateSnapshotCommand,
  CreateVolumeCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  EC2Client,
  paginateDescribeSnapshots,
  paginateDescribeVolumes,
  waitUntilSnapshotCompleted,
  waitUntilVolumeAvailable,
  type Filter,
  type Tag,
} from "@aws-sdk/client-ec2";
import { DEFAULT_AWS_REGION } from "@edd/config";
import {
  isoTimestamp,
  snapshotId,
  volumeId,
  type Snapshot,
  type SnapshotId,
  type SnapshotRef,
  type StorageProvider,
  type Volume,
  type VolumeId,
  type VolumeRef,
} from "@edd/core";

/** Size of a freshly-created (non-hydrated) EBS volume, in GiB. */
const DEFAULT_VOLUME_SIZE_GIB = 8;
/** Max seconds a create/snapshot waiter polls for the resource to settle. */
const SETTLE_WAIT_SECONDS = 60;

/**
 * Tag every volume/snapshot we create carries. Enumeration (and therefore GC)
 * only ever considers resources bearing it — so GC can never delete an EBS
 * resource this control plane did not create, even in a shared AWS account.
 */
const MANAGED_TAG_KEY = "edd:managed";
const MANAGED_TAG_VALUE = "true";
/** Optional partition within managed resources (e.g. environment, or test run). */
const SCOPE_TAG_KEY = "edd:scope";

export interface Ec2StorageProviderDeps {
  client: EC2Client;
  /** AZ for new volumes; defaults to `${region}a`. */
  availabilityZone?: string;
  region?: string;
  /** Restrict managed resources to this scope (tagged + filtered on enumerate). */
  scope?: string;
}

/** Throw if a required field the cloud should have returned is absent. */
function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`EC2 response missing required field: ${field}`);
  return value;
}

/**
 * Real EBS-backed StorageProvider over the EC2 API. Identical against the
 * sockerless AWS simulator and real AWS — only the endpoint differs (AGENTS.md
 * §6.8). Implements the volume/snapshot **lifecycle** (create/snapshot/restore/
 * delete/enumerate); a volume's **file** contents cannot be read/written through
 * the EC2 API without attaching the volume to a running task, so `readFile`/
 * `writeFile` are deferred to the compute layer.
 *
 * Created resources are tagged `edd:managed=true` (+ an optional `edd:scope`), and
 * enumeration scopes to those tags with server-side `tag:` Filters — so GC stays
 * scoped to what we manage. (Standard EC2 behaviour; no client-side re-filter,
 * which would be a target-specific workaround — §6.9.)
 */
export class Ec2StorageProvider implements StorageProvider {
  private readonly client: EC2Client;
  private readonly availabilityZone: string;
  private readonly scope?: string;

  constructor(deps: Ec2StorageProviderDeps) {
    this.client = deps.client;
    this.availabilityZone = deps.availabilityZone ?? `${deps.region ?? DEFAULT_AWS_REGION}a`;
    this.scope = deps.scope;
  }

  /** Build a provider from the ambient AWS env (`AWS_ENDPOINT_URL` → the sim). */
  static fromEnv(opts: { scope?: string } = {}): Ec2StorageProvider {
    const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION;
    const endpoint = process.env.AWS_ENDPOINT_URL;
    const client = new EC2Client({
      region,
      ...(endpoint
        ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
        : {}),
    });
    return new Ec2StorageProvider({ client, region, ...opts });
  }

  private managedTags(): Tag[] {
    const tags: Tag[] = [{ Key: MANAGED_TAG_KEY, Value: MANAGED_TAG_VALUE }];
    if (this.scope !== undefined) tags.push({ Key: SCOPE_TAG_KEY, Value: this.scope });
    return tags;
  }

  private managedFilters(): Filter[] {
    const filters: Filter[] = [{ Name: `tag:${MANAGED_TAG_KEY}`, Values: [MANAGED_TAG_VALUE] }];
    if (this.scope !== undefined)
      filters.push({ Name: `tag:${SCOPE_TAG_KEY}`, Values: [this.scope] });
    return filters;
  }

  async createVolume(opts?: { fromSnapshot?: SnapshotId }): Promise<Volume> {
    const out = await this.client.send(
      new CreateVolumeCommand({
        AvailabilityZone: this.availabilityZone,
        ...(opts?.fromSnapshot
          ? { SnapshotId: opts.fromSnapshot }
          : { Size: DEFAULT_VOLUME_SIZE_GIB }),
        TagSpecifications: [{ ResourceType: "volume", Tags: this.managedTags() }],
      }),
    );
    const id = volumeId(required(out.VolumeId, "VolumeId"));
    await waitUntilVolumeAvailable(
      { client: this.client, maxWaitTime: SETTLE_WAIT_SECONDS },
      { VolumeIds: [id] },
    );
    return opts?.fromSnapshot ? { id, hydratedFrom: opts.fromSnapshot } : { id };
  }

  async createSnapshot(volume: VolumeId): Promise<Snapshot> {
    const out = await this.client.send(
      new CreateSnapshotCommand({
        VolumeId: volume,
        TagSpecifications: [{ ResourceType: "snapshot", Tags: this.managedTags() }],
      }),
    );
    const id = snapshotId(required(out.SnapshotId, "SnapshotId"));
    await waitUntilSnapshotCompleted(
      { client: this.client, maxWaitTime: SETTLE_WAIT_SECONDS },
      { SnapshotIds: [id] },
    );
    return { id, sourceVolumeId: volume };
  }

  async deleteVolume(volume: VolumeId): Promise<void> {
    await this.client.send(new DeleteVolumeCommand({ VolumeId: volume }));
  }

  async deleteSnapshot(snapshot: SnapshotId): Promise<void> {
    await this.client.send(new DeleteSnapshotCommand({ SnapshotId: snapshot }));
  }

  async listVolumes(): Promise<readonly VolumeRef[]> {
    const refs: VolumeRef[] = [];
    for await (const page of paginateDescribeVolumes(
      { client: this.client },
      { Filters: this.managedFilters() },
    )) {
      for (const v of page.Volumes ?? []) {
        refs.push({
          id: volumeId(required(v.VolumeId, "VolumeId")),
          createdAt: isoTimestamp(required(v.CreateTime, "CreateTime").toISOString()),
        });
      }
    }
    return refs;
  }

  async listSnapshots(): Promise<readonly SnapshotRef[]> {
    const refs: SnapshotRef[] = [];
    // OwnerIds=self — without it real AWS returns every public snapshot.
    for await (const page of paginateDescribeSnapshots(
      { client: this.client },
      { OwnerIds: ["self"], Filters: this.managedFilters() },
    )) {
      for (const s of page.Snapshots ?? []) {
        refs.push({
          id: snapshotId(required(s.SnapshotId, "SnapshotId")),
          createdAt: isoTimestamp(required(s.StartTime, "StartTime").toISOString()),
          sourceVolumeId: volumeId(required(s.VolumeId, "VolumeId")),
        });
      }
    }
    return refs;
  }

  readFile(): Promise<Buffer | null> {
    throw new Error(
      "Ec2StorageProvider cannot read volume files via the EC2 API; volume data I/O " +
        "requires attaching to a running task (compute).",
    );
  }

  writeFile(): Promise<void> {
    throw new Error(
      "Ec2StorageProvider cannot write volume files via the EC2 API; volume data I/O " +
        "requires attaching to a running task (compute).",
    );
  }
}
