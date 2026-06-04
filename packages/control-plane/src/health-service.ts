// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isoTimestamp,
  summarizeHealth,
  type Clock,
  type ComponentHealth,
  type ComputeProvider,
  type HealthReport,
  type StorageProvider,
} from "@edd/core";

export interface HealthServiceDeps {
  storage: StorageProvider;
  compute: ComputeProvider;
  /** DynamoDB ping (e.g. `@edd/db` `pingTable`) — the one real dependency locally. */
  pingDatabase: () => Promise<ComponentHealth>;
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
    const components: ComponentHealth[] = [
      { component: "control-plane", status: "ok", detail: "API responding" },
      await this.deps.pingDatabase(),
      await providerHealth("compute", this.deps.compute),
      await providerHealth("storage", this.deps.storage),
      {
        component: "reconciler",
        status: "unknown",
        detail: "no local run history (CloudWatch on AWS)",
      },
    ];
    return summarizeHealth(components, isoTimestamp(this.deps.clock.now()));
  }
}
