// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { ACTIVITY_MIN_WRITE_INTERVAL_MS, shouldRecordActivity } from "./system-activity";

describe("shouldRecordActivity", () => {
  const MIN = ACTIVITY_MIN_WRITE_INTERVAL_MS;

  it("records on the first request (no prior write)", () => {
    expect(shouldRecordActivity(undefined, 1_000_000, MIN)).toBe(true);
  });

  it("skips while still within the throttle window", () => {
    const last = 1_000_000;
    expect(shouldRecordActivity(last, last + MIN - 1, MIN)).toBe(false);
  });

  it("records again once the window has elapsed", () => {
    const last = 1_000_000;
    expect(shouldRecordActivity(last, last + MIN, MIN)).toBe(true);
    expect(shouldRecordActivity(last, last + MIN * 5, MIN)).toBe(true);
  });

  it("never writes on a non-finite clock (defensive)", () => {
    expect(shouldRecordActivity(undefined, Number.NaN, MIN)).toBe(false);
    expect(shouldRecordActivity(1_000_000, Number.POSITIVE_INFINITY, MIN)).toBe(false);
  });
});
