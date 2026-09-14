// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isoTimestamp,
  reconcilerHealthFromHeartbeat,
  summarizeHealth,
  type Clock,
  type ComponentHealth,
  type ComputeProvider,
  type HealthReport,
  type IsoTimestamp,
  type StorageProvider,
} from "@edd/core";

export interface HealthServiceDeps {
  storage: StorageProvider;
  compute: ComputeProvider;
  /** DynamoDB ping (e.g. `@edd/db` `pingTable`) — the one real dependency locally. */
  pingDatabase: () => Promise<ComponentHealth>;
  /** Reads the reconciler's last-successful-sweep timestamp, or null if none yet.
   * Absent → the board reports the reconciler `unknown` (no source wired). */
  reconcilerHeartbeat?: () => Promise<{ lastRunAt: string } | null>;
  /** How this deployment obtains git access for sessions (GitHub App / account linking /
   * nothing beyond public HTTPS and user SSH keys), with a live check where one is
   * possible. Absent → not reported. */
  gitIntegration?: () => Promise<ComponentHealth>;
  clock: Clock;
}

/** A provider's health, or `unknown` if it implements no live check (real on AWS). */
async function providerHealth(
  name: string,
  provider: {
    health?: () => Promise<ComponentHealth>;
  },
): Promise<ComponentHealth> {
  if (provider.health) return provider.health();
  return { component: name, status: "unknown", detail: "live check available on AWS" };
}

/**
 * Aggregates dependency health for the admin Health board. The control plane and
 * DynamoDB checks are real now; compute/storage report their adapter's `health()`
 * (the fakes say so) and the reconciler is `unknown` locally (CloudWatch on AWS).
 */
export class HealthService {
  constructor(private readonly deps: HealthServiceDeps) {}

  async report(): Promise<HealthReport> {
    const now = isoTimestamp(this.deps.clock.now());
    // The checks are independent, so they run at once. Awaited one after another
    // their round-trips added up: this report feeds GET /api/observations, which
    // Shauth's monitoring abandons after five seconds, and on 2026-09-14 the
    // observation took 5.8 s and failed the Scaleway post-apply gate. The order of
    // the components is unchanged.
    const [database, compute, storage, reconciler, git] = await Promise.all([
      this.deps.pingDatabase(),
      providerHealth("compute", this.deps.compute),
      providerHealth("storage", this.deps.storage),
      this.reconcilerHealth(now),
      this.deps.gitIntegration === undefined ? undefined : this.deps.gitIntegration(),
    ]);
    const components: ComponentHealth[] = [
      { component: "control-plane", status: "ok", detail: "API responding" },
      database,
      compute,
      storage,
      reconciler,
      ...(git === undefined ? [] : [git]),
    ];
    return summarizeHealth(components, now);
  }

  /** Reconciler health from its heartbeat (staleness), or `unknown` if no reader
   * is wired or no sweep has run yet. */
  private async reconcilerHealth(now: IsoTimestamp): Promise<ComponentHealth> {
    if (this.deps.reconcilerHeartbeat === undefined) {
      return { component: "reconciler", status: "unknown", detail: "no heartbeat source wired" };
    }
    const beat = await this.deps.reconcilerHeartbeat();
    const lastRunAt = beat === null ? undefined : isoTimestamp(beat.lastRunAt);
    return reconcilerHealthFromHeartbeat(lastRunAt, now);
  }
}
