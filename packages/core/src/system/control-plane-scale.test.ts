// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isoTimestamp } from "../domain/ids";

import { decideControlPlaneIdle, decideControlPlaneWake } from "./control-plane-scale";

const FIFTEEN_MIN = 15 * 60 * 1000;
const at = (ms: number): ReturnType<typeof isoTimestamp> =>
  isoTimestamp(new Date(ms).toISOString());

describe("decideControlPlaneIdle", () => {
  it("scales to zero once idle past the threshold", () => {
    const d = decideControlPlaneIdle({
      currentDesired: 2,
      lastActivityAt: at(0),
      now: at(FIFTEEN_MIN),
      idleThresholdMs: FIFTEEN_MIN,
    });
    expect(d.action).toBe("scale-to-zero");
  });

  it("holds while still within the idle window", () => {
    const d = decideControlPlaneIdle({
      currentDesired: 2,
      lastActivityAt: at(0),
      now: at(FIFTEEN_MIN - 1),
      idleThresholdMs: FIFTEEN_MIN,
    });
    expect(d.action).toBe("hold");
  });

  it("holds when already scaled to zero (nothing to shut down)", () => {
    const d = decideControlPlaneIdle({
      currentDesired: 0,
      lastActivityAt: at(0),
      now: at(FIFTEEN_MIN * 10),
      idleThresholdMs: FIFTEEN_MIN,
    });
    expect(d.action).toBe("hold");
  });

  it("holds during startup grace (no activity recorded yet) — never kills a waking CP", () => {
    const d = decideControlPlaneIdle({
      currentDesired: 2,
      lastActivityAt: undefined,
      now: at(FIFTEEN_MIN * 10),
      idleThresholdMs: FIFTEEN_MIN,
    });
    expect(d.action).toBe("hold");
  });

  it("holds on a future-dated activity (writer clock skew), never scales on negative idle", () => {
    const d = decideControlPlaneIdle({
      currentDesired: 2,
      lastActivityAt: at(FIFTEEN_MIN * 2),
      now: at(FIFTEEN_MIN),
      idleThresholdMs: FIFTEEN_MIN,
    });
    expect(d.action).toBe("hold");
  });

  it("holds on an unparseable timestamp rather than scaling", () => {
    const d = decideControlPlaneIdle({
      currentDesired: 2,
      lastActivityAt: isoTimestamp("not-a-date"),
      now: at(FIFTEEN_MIN * 10),
      idleThresholdMs: FIFTEEN_MIN,
    });
    expect(d.action).toBe("hold");
  });
});

describe("decideControlPlaneWake", () => {
  it("wakes a zeroed service up to the active desired count", () => {
    const d = decideControlPlaneWake({ currentDesired: 0, activeDesired: 2 });
    expect(d).toMatchObject({ action: "wake", to: 2 });
  });

  it("is idempotent when already at/above the active count (concurrent wakes)", () => {
    expect(decideControlPlaneWake({ currentDesired: 2, activeDesired: 2 }).action).toBe("hold");
    expect(decideControlPlaneWake({ currentDesired: 3, activeDesired: 2 }).action).toBe("hold");
  });

  it("holds on a non-positive active desired count (misconfiguration, fail safe)", () => {
    expect(decideControlPlaneWake({ currentDesired: 0, activeDesired: 0 }).action).toBe("hold");
  });
});
