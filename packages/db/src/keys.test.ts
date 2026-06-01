// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { keys } from "./index";

describe("single-table keys", () => {
  it("co-locates a workspace and its snapshots under one partition", () => {
    const ws = keys.workspace("ws-1");
    const snap = keys.snapshot("ws-1", "snap-1");
    expect(snap.PK).toBe(ws.PK);
    expect(snap.SK).toBe("SNAPSHOT#snap-1");
  });

  it("builds the reconciler GSI key (state + activity)", () => {
    const k = keys.byStateActivity("idle", "2026-06-01T00:00:00.000Z");
    expect(k.GSI2PK).toBe("STATE#idle");
    expect(k.GSI2SK).toBe("ACTIVITY#2026-06-01T00:00:00.000Z");
  });
});
