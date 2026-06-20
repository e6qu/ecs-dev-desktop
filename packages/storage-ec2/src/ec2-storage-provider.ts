// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CopySnapshotCommand,
  CreateSnapshotCommand,
  CreateTagsCommand,
  CreateVolumeCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeAvailabilityZonesCommand,
  EC2Client,
  paginateDescribeSnapshots,
  paginateDescribeVolumes,
  waitUntilSnapshotCompleted,
  waitUntilVolumeAvailable,
  type Filter,
  type Tag,
} from "@aws-sdk/client-ec2";
import { AWS_SDK_MAX_ATTEMPTS, AWS_SDK_RETRY_MODE, DEFAULT_AWS_REGION } from "@edd/config";
import {
  isoTimestamp,
  snapshotId,
  volumeId,
  type ComponentHealth,
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
/** Marks a data-safety snapshot kept past delete (the Middle retention policy);
 * orphan-GC keeps any snapshot carrying it regardless of the grace window. */
const RETAIN_TAG_KEY = "edd:retain";
const RETAIN_TAG_VALUE = "true";

export interface Ec2StorageProviderDeps {
  client: EC2Client;
  /** AZ for new volumes; defaults to `${region}a`. */
  availabilityZone?: string;
  region?: string;
  /** Restrict managed resources to this scope (tagged + filtered on enumerate). */
  scope?: string;
  /** Build an EC2 client for another region (cross-region snapshot copy / DR). The
   * same coordinates as the source — only the region changes — so it hits the sim
   * (shared endpoint) or real AWS (per-region endpoint) by config alone (§6.9).
   * Absent ⇒ `copySnapshot` is unavailable. */
  clientForRegion?: (region: string) => EC2Client;
}

/** Throw if a required field the cloud should have returned is absent. */
function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`EC2 response missing required field: ${field}`);
  return value;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  private readonly region: string;
  private readonly scope?: string;
  private readonly clientForRegion?: (region: string) => EC2Client;

  constructor(deps: Ec2StorageProviderDeps) {
    this.client = deps.client;
    this.region = deps.region ?? DEFAULT_AWS_REGION;
    this.availabilityZone = deps.availabilityZone ?? `${this.region}a`;
    this.scope = deps.scope;
    this.clientForRegion = deps.clientForRegion;
  }

  /** Build a provider from the ambient AWS env (`AWS_ENDPOINT_URL` → the sim). */
  static fromEnv(opts: { scope?: string } = {}): Ec2StorageProvider {
    const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION;
    const endpoint = process.env.AWS_ENDPOINT_URL;
    const clientForRegion = (r: string): EC2Client =>
      new EC2Client({
        region: r,
        maxAttempts: AWS_SDK_MAX_ATTEMPTS,
        retryMode: AWS_SDK_RETRY_MODE,
        ...(endpoint
          ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
          : {}),
      });
    return new Ec2StorageProvider({
      client: clientForRegion(region),
      region,
      clientForRegion,
      ...opts,
    });
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
    try {
      await waitUntilVolumeAvailable(
        { client: this.client, maxWaitTime: SETTLE_WAIT_SECONDS },
        { VolumeIds: [id] },
      );
    } catch (err) {
      return await this.deleteOrSurfaceLeak(() => this.deleteVolume(id), `volume ${id}`, err);
    }
    return opts?.fromSnapshot ? { id, hydratedFrom: opts.fromSnapshot } : { id };
  }

  async createSnapshot(volume: VolumeId, opts?: { retain?: boolean }): Promise<Snapshot> {
    const tags =
      opts?.retain === true
        ? [...this.managedTags(), { Key: RETAIN_TAG_KEY, Value: RETAIN_TAG_VALUE }]
        : this.managedTags();
    const out = await this.client.send(
      new CreateSnapshotCommand({
        VolumeId: volume,
        TagSpecifications: [{ ResourceType: "snapshot", Tags: tags }],
      }),
    );
    const id = snapshotId(required(out.SnapshotId, "SnapshotId"));
    try {
      await waitUntilSnapshotCompleted(
        { client: this.client, maxWaitTime: SETTLE_WAIT_SECONDS },
        { SnapshotIds: [id] },
      );
    } catch (err) {
      return await this.deleteOrSurfaceLeak(() => this.deleteSnapshot(id), `snapshot ${id}`, err);
    }
    return { id, sourceVolumeId: volume };
  }

  /** Tag an existing snapshot retained (idempotent — CreateTags is upsert). */
  async tagSnapshotRetained(snapshot: SnapshotId): Promise<void> {
    await this.client.send(
      new CreateTagsCommand({
        Resources: [snapshot],
        Tags: [{ Key: RETAIN_TAG_KEY, Value: RETAIN_TAG_VALUE }],
      }),
    );
  }

  /**
   * Copy a snapshot to `destinationRegion` for disaster recovery. CopySnapshot is
   * issued AGAINST the destination region (it names the origin via `SourceRegion`),
   * so we build a client for that region with the same coordinates (endpoint/creds)
   * as the source — the sim (shared endpoint) or real AWS (per-region) by config
   * alone (§6.9). The copy is tagged managed so it enumerates + GCs like any other.
   */
  async copySnapshot(snapshot: SnapshotId, destinationRegion: string): Promise<SnapshotId> {
    if (this.clientForRegion === undefined) {
      throw new Error("copySnapshot requires a clientForRegion factory (cross-region DR)");
    }
    const dest = this.clientForRegion(destinationRegion);
    const out = await dest.send(
      new CopySnapshotCommand({
        SourceRegion: this.region,
        SourceSnapshotId: snapshot,
        Description: `edd DR copy of ${snapshot} from ${this.region}`,
        TagSpecifications: [{ ResourceType: "snapshot", Tags: this.managedTags() }],
      }),
    );
    const id = snapshotId(required(out.SnapshotId, "copied SnapshotId"));
    // The copy starts `pending`; a volume can only hydrate from a `completed`
    // snapshot, so wait for it to settle in the destination region before returning.
    try {
      await waitUntilSnapshotCompleted(
        { client: dest, maxWaitTime: SETTLE_WAIT_SECONDS },
        { SnapshotIds: [id] },
      );
    } catch (err) {
      return await this.deleteOrSurfaceLeak(
        () => dest.send(new DeleteSnapshotCommand({ SnapshotId: id })).then(() => undefined),
        `copied snapshot ${id}`,
        err,
      );
    }
    return id;
  }

  async deleteVolume(volume: VolumeId): Promise<void> {
    await this.client.send(new DeleteVolumeCommand({ VolumeId: volume }));
  }

  async deleteSnapshot(snapshot: SnapshotId): Promise<void> {
    await this.client.send(new DeleteSnapshotCommand({ SnapshotId: snapshot }));
  }

  /**
   * A resource was created but never settled (its post-create waiter failed —
   * timeout or an `error` state). Delete it so a failed create doesn't leak EBS,
   * then rethrow the original error. The reconciler GC would eventually reap the
   * tagged orphan, but immediate cleanup avoids the cost-accrual window (and a
   * retry storm piling up orphans faster than GC reaps). If the cleanup delete
   * ALSO fails it is surfaced, not swallowed (§6.5), so a leaked resource is visible.
   */
  private async deleteOrSurfaceLeak(
    remove: () => Promise<void>,
    what: string,
    cause: unknown,
  ): Promise<never> {
    try {
      await remove();
    } catch (cleanupErr) {
      throw new Error(
        `${what} was created but never became available and could not be deleted ` +
          `(may be leaked until GC): ${errMessage(cause)}; cleanup: ${errMessage(cleanupErr)}`,
        { cause: cleanupErr },
      );
    }
    throw cause instanceof Error ? cause : new Error(errMessage(cause));
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
        const retained = (s.Tags ?? []).some(
          (t) => t.Key === RETAIN_TAG_KEY && t.Value === RETAIN_TAG_VALUE,
        );
        refs.push({
          id: snapshotId(required(s.SnapshotId, "SnapshotId")),
          createdAt: isoTimestamp(required(s.StartTime, "StartTime").toISOString()),
          sourceVolumeId: volumeId(required(s.VolumeId, "VolumeId")),
          ...(retained ? { retained: true } : {}),
        });
      }
    }
    return refs;
  }

  /**
   * Live storage-plane health for the admin Health board: a lightweight read-only
   * `DescribeAvailabilityZones` confirms the EC2 control plane is reachable and the
   * credentials are valid (the EBS volume/snapshot APIs live on the same surface).
   * Reachable AZs → ok; an API error (unreachable/denied) → down. Without this the
   * board reported storage `unknown` even on AWS (the same inverted contract that
   * was closed for compute) — an EBS/EC2 outage would have been invisible.
   */
  async health(): Promise<ComponentHealth> {
    try {
      const out = await this.client.send(new DescribeAvailabilityZonesCommand({}));
      const available = (out.AvailabilityZones ?? []).filter(
        (az) => az.State === "available",
      ).length;
      if (available > 0) {
        return { component: "storage", status: "ok", detail: `EC2 reachable (${available} AZ)` };
      }
      return {
        component: "storage",
        status: "degraded",
        detail: "EC2 reachable but no AZ reports available",
      };
    } catch (err) {
      return {
        component: "storage",
        status: "down",
        detail: `EC2 DescribeAvailabilityZones failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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
