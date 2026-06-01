// SPDX-License-Identifier: AGPL-3.0-or-later

/** Injectable clock so timestamps are deterministic in tests. */
export interface Clock {
  /** Current time as an ISO-8601 string. */
  now(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

/** Test clock that returns a fixed (optionally advancing) timestamp. */
export function fixedClock(iso = "2026-06-01T00:00:00.000Z"): Clock {
  return { now: () => iso };
}
