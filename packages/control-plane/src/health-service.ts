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
    const components: ComponentHealth[] = [
      { component: "control-plane", status: "ok", detail: "API responding" },
      await this.deps.pingDatabase(),
      await providerHealth("compute", this.deps.compute),
      await providerHealth("storage", this.deps.storage),
      await this.reconcilerHealth(now),
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
