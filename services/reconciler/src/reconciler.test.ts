// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { decideAction } from "./index";

describe("reconciler decideAction", () => {
  const idleThresholdMs = 30 * 60 * 1000;

  it("stops a workspace idle past the threshold", () => {
    expect(
      decideAction({ state: "idle", msSinceActivity: idleThresholdMs + 1, idleThresholdMs }),
    ).toBe("stop");
  });

  it("leaves an active workspace alone", () => {
    expect(
      decideAction({ state: "running", msSinceActivity: 1000, idleThresholdMs }),
    ).toBe("noop");
  });
});
