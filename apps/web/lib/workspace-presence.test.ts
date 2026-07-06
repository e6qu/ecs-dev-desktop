// SPDX-License-Identifier: AGPL-3.0-or-later
import { workspaceId } from "@edd/core";
import { describe, expect, it } from "vitest";

import { PresenceRegistry } from "./workspace-presence";

const WS_A = workspaceId("ws-aaa");
const WS_B = workspaceId("ws-bbb");
const NOW = 1_000_000;

describe("PresenceRegistry", () => {
  it("a tracked connection marks its workspace loaded until untracked", () => {
    const reg = new PresenceRegistry();
    const untrack = reg.track(WS_A, NOW + 60_000);
    expect(reg.loadedWorkspaces(NOW)).toEqual([WS_A]);
    untrack();
    expect(reg.loadedWorkspaces(NOW)).toEqual([]);
  });

  it("deduplicates multiple connections to the same workspace", () => {
    const reg = new PresenceRegistry();
    reg.track(WS_A, NOW + 60_000);
    reg.track(WS_A, NOW + 60_000);
    reg.track(WS_B, NOW + 60_000);
    expect(reg.loadedWorkspaces(NOW).sort()).toEqual([WS_A, WS_B]);
  });

  it("a connection stops counting once its session expires (and is pruned)", () => {
    const reg = new PresenceRegistry();
    reg.track(WS_A, NOW + 60_000);
    expect(reg.loadedWorkspaces(NOW + 59_999)).toEqual([WS_A]);
    // At/after expiry: no longer presence, even though the socket never closed —
    // this is what caps a background-tab workspace at the session length.
    expect(reg.loadedWorkspaces(NOW + 60_000)).toEqual([]);
    expect(reg.size()).toBe(0); // pruned
  });

  it("untrack is idempotent and never affects other connections", () => {
    const reg = new PresenceRegistry();
    const untrackA = reg.track(WS_A, NOW + 60_000);
    reg.track(WS_B, NOW + 60_000);
    untrackA();
    untrackA();
    expect(reg.loadedWorkspaces(NOW)).toEqual([WS_B]);
  });
});
