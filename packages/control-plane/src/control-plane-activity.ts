// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Control-plane activity ledger — the application half of control-plane
 * scale-to-zero. A single fixed-id DynamoDB record holds the instant of the last
 * real authenticated user request the control plane served. The web app upserts it
 * (throttled by the caller — see `apps/web/lib/system-activity.ts`) on each
 * authenticated request; the reconciler's idle-shutdown sweep reads it and feeds it
 * to `decideControlPlaneIdle` (@edd/core) to decide when to scale the control-plane
 * ECS service to zero.
 *
 * The imperative shell is deliberately tiny: all the DECISION logic lives in the pure
 * core; this only reads/writes the one row.
 */
import { isoTimestamp, type IsoTimestamp } from "@edd/core";
import { CONTROL_PLANE_ACTIVITY_ID, type ControlPlaneActivityEntity } from "@edd/db";

/**
 * Persisted-state schema version (§6.5a). Bump whenever the stored shape changes;
 * `readLastActivity` accepts ONLY this version and discards anything else, so a stale
 * blob written by older code can never be read into newer code with an absent field.
 */
export const CONTROL_PLANE_ACTIVITY_SCHEMA_VERSION = 1;

export interface ControlPlaneActivityServiceDeps {
  /** The `controlPlaneActivity` single-table entity (from `@edd/db`). */
  activity: ControlPlaneActivityEntity;
}

/**
 * Reads + writes the singleton control-plane activity record. Injected with the
 * DynamoDB entity so it is unit/integration-testable against the sim's DynamoDB with
 * zero AWS-vs-sim branching (§6.9 — coordinates only).
 */
export class ControlPlaneActivityService {
  constructor(private readonly deps: ControlPlaneActivityServiceDeps) {}

  /**
   * Record `now` as the last-activity instant (idempotent upsert — a plain `put`
   * overwrites the single row). Throttling is the CALLER's responsibility: a busy
   * control plane must not write DynamoDB on every request (see
   * `shouldRecordActivity`), so this does no rate-limiting of its own.
   */
  async recordActivity(now: IsoTimestamp): Promise<void> {
    await this.deps.activity
      .put({
        id: CONTROL_PLANE_ACTIVITY_ID,
        schemaVersion: CONTROL_PLANE_ACTIVITY_SCHEMA_VERSION,
        lastActivityAt: now,
      })
      .go();
  }

  /**
   * The last recorded activity instant, or `undefined` when none has been recorded
   * yet (a freshly-provisioned control plane) OR when the persisted row is a stale
   * schema version (§6.5a — discarded, not read into newer code). An `undefined` is a
   * HOLD in `decideControlPlaneIdle`, never an immediate shutdown.
   */
  async readLastActivity(): Promise<IsoTimestamp | undefined> {
    const r = await this.deps.activity.get({ id: CONTROL_PLANE_ACTIVITY_ID }).go();
    if (r.data === null) return undefined;
    if (r.data.schemaVersion !== CONTROL_PLANE_ACTIVITY_SCHEMA_VERSION) return undefined;
    return isoTimestamp(r.data.lastActivityAt);
  }
}
