// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { statusMeta } from "./workspace-view";

describe("statusMeta", () => {
  it("pulses for live states", () => {
    expect(statusMeta("running").pulse).toBe(true);
    expect(statusMeta("stopped").pulse).toBe(false);
  });
});

// `availableActions` moved to `@edd/core` (`workspaceActions`) — see its test there.
