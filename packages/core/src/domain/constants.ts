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
} as const;

/** Default idle window before scale-to-zero: 30 minutes. */
export const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;
