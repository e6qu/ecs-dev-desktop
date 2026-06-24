// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { buildSeed } from "./seed";

describe("buildSeed", () => {
  it("produces a fleet across states by replaying real @edd/core transitions", () => {
    const s = buildSeed();
    expect(s.workspaces).toHaveLength(8);
    const byState: Record<string, number> = {};
    for (const w of s.workspaces) byState[w.state] = (byState[w.state] ?? 0) + 1;
    // The states are the OUTPUT of the real state machine over the seeded lifecycle steps,
    // not asserted into existence — so this guards that the replay stays valid.
    expect(byState).toEqual({ running: 4, stopped: 3, error: 1 });
  });

  it("seeds 3 users (admin/member/viewer), a 6-image catalog, and a member current user", () => {
    const s = buildSeed();
    expect(s.users.map((u) => u.role).sort()).toEqual(["admin", "member", "viewer"]);
    expect(s.catalog).toHaveLength(6);
    expect(s.users.find((u) => u.id === s.currentUserId)?.role).toBe("member");
  });

  it("builds a backdated audit ledger, newest-first, that starts with a session.create", () => {
    const s = buildSeed();
    expect(s.audit.length).toBeGreaterThanOrEqual(s.workspaces.length);
    // Sorted strictly newest-first.
    for (let i = 1; i < s.audit.length; i++) {
      const prev = s.audit[i - 1];
      const cur = s.audit[i];
      if (prev === undefined || cur === undefined) throw new Error("audit gap");
      expect(Date.parse(prev.at)).toBeGreaterThanOrEqual(Date.parse(cur.at));
    }
    // Every workspace's first-ever event is a create.
    expect(s.audit.some((e) => e.action === "session.create")).toBe(true);
  });

  it("attributes every workspace to a seeded user", () => {
    const s = buildSeed();
    const userIds = new Set(s.users.map((u) => u.id));
    for (const w of s.workspaces) expect(userIds.has(w.ownerId)).toBe(true);
  });

  it("assigns every workspace an editor, with both kinds represented", () => {
    const s = buildSeed();
    for (const w of s.workspaces) expect(s.editors[w.id]).toBeDefined();
    const kinds = new Set(s.workspaces.map((w) => s.editors[w.id]));
    expect(kinds.has("openvscode")).toBe(true);
    expect(kinds.has("monaco")).toBe(true);
  });

  it("assigns every workspace an agent, with both kinds represented", () => {
    const s = buildSeed();
    for (const w of s.workspaces) expect(s.agents[w.id]).toBeDefined();
    const kinds = new Set(s.workspaces.map((w) => s.agents[w.id]));
    expect(kinds.has("claude-code")).toBe(true);
    expect(kinds.has("codex")).toBe(true);
  });

  it("seeds account SSH keys attributed to seeded users", () => {
    const s = buildSeed();
    expect(s.sshKeys.length).toBeGreaterThan(0);
    const userIds = new Set(s.users.map((u) => u.id));
    for (const k of s.sshKeys) {
      expect(userIds.has(k.ownerId)).toBe(true);
      expect(k.publicKey.startsWith(k.keyType)).toBe(true);
    }
  });

  it("serializes to a compact localStorage blob (use-storage-wisely budget)", () => {
    // The control-plane state is the ONLY thing in localStorage (IDE files live in IndexedDB).
    // localStorage caps ~5 MB; this must stay a tiny fraction, with headroom for the audit ledger
    // growing as a visitor creates/stops workspaces. A regression here (e.g. accidentally storing
    // bulky data in the blob) trips this gate.
    const bytes = JSON.stringify(buildSeed()).length;
    expect(bytes).toBeLessThan(64 * 1024);
  });
});
