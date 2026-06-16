// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Domain constants. No magic literals elsewhere in the core — values with
 * meaning are named and documented here.
 */

/** Prefixes that make ids self-describing in logs and the data store. */
export const ID_PREFIX = {
  workspace: "ws-",
  volume: "vol-",
  snapshot: "snap-",
  task: "task-",
  baseImage: "img-",
  sshKey: "sshk-",
} as const;

/** Default idle window before scale-to-zero: 30 minutes. */
export const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

/** Default interval between scheduled point-in-time snapshots: 6 hours. */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Grace window before an unreferenced volume/snapshot becomes GC-eligible: 1
 * hour. Guards against reaping a resource that was just created but is not yet
 * recorded against a workspace in the control plane (a create/persist race).
 */
export const DEFAULT_GC_GRACE_MS = 60 * 60 * 1000;

/** Default number of most-recent events the admin audit feed returns. */
export const DEFAULT_AUDIT_FEED_LIMIT = 100;

/**
 * How long since the reconciler's last successful sweep before the Health board
 * reports it `degraded`: 15 minutes (3× the default `rate(5 minutes)` schedule, so
 * a single missed run is tolerated but a stalled loop is surfaced).
 */
export const DEFAULT_RECONCILER_STALE_MS = 15 * 60 * 1000;
