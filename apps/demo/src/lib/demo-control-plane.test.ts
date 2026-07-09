// SPDX-License-Identifier: AGPL-3.0-or-later
import { baseImage } from "@edd/core";
import { beforeEach, describe, expect, it } from "vitest";

// Minimal localStorage for the node test env (the control plane persists through it).
class MemStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
}
globalThis.localStorage = new MemStorage();

// Import AFTER localStorage exists (the constructor reads it).
const { DemoControlPlane } = await import("./demo-control-plane");

describe("DemoControlPlane", () => {
  let cp: InstanceType<typeof DemoControlPlane>;
  beforeEach(() => {
    globalThis.localStorage.clear();
    cp = new DemoControlPlane();
  });

  it("seeds a fleet + catalog on first construction", () => {
    expect(cp.workspaces().length).toBeGreaterThan(0);
    expect(cp.catalog()).toHaveLength(6);
    expect(cp.audit().length).toBeGreaterThan(0);
  });

  it("create / stop drive the real state machine + grow the audit ledger", () => {
    const before = cp.workspaces({ mine: true }).length;
    const auditBefore = cp.audit().length;
    cp.create(baseImage("golden/go"));
    const mine = cp.workspaces({ mine: true });
    expect(mine.length).toBe(before + 1);
    const fresh = mine.find((w) => w.state === "running");
    expect(fresh).toBeDefined();
    if (fresh === undefined) throw new Error("no fresh running workspace");
    cp.stop(fresh.id);
    expect(cp.workspaces().find((w) => w.id === fresh.id)?.state).toBe("stopped");
    expect(cp.audit().length).toBe(auditBefore + 2); // create + stop
  });

  it("costReport prices the seeded ledger (real cost model), most-expensive first", () => {
    const report = cp.costReport();
    expect(report.total.totalUsd).toBeGreaterThan(0);
    expect(report.byUser.length).toBeGreaterThan(0);
    expect(report.bySession.length).toBeGreaterThan(0);
    // Sorted most-expensive first.
    for (let i = 1; i < report.byUser.length; i++) {
      const prev = report.byUser[i - 1];
      const cur = report.byUser[i];
      if (prev === undefined || cur === undefined) throw new Error("gap");
      expect(prev.totalUsd).toBeGreaterThanOrEqual(cur.totalUsd);
    }
  });

  it("a 1-day window prices less than (or equal to) lifetime", () => {
    expect(cp.costReport(1).total.totalUsd).toBeLessThanOrEqual(cp.costReport().total.totalUsd);
  });

  it("records the environment's editor choice; unknown ids default to OpenVSCode", () => {
    cp.create(baseImage("golden/go"), "monaco");
    const monacoWs = cp.workspaces({ mine: true }).find((w) => cp.editorFor(w.id) === "monaco");
    expect(monacoWs).toBeDefined();
    cp.create(baseImage("golden/go")); // default
    expect(cp.workspaces({ mine: true }).some((w) => cp.editorFor(w.id) === "openvscode")).toBe(
      true,
    );
    expect(cp.editorFor("does-not-exist")).toBe("openvscode");
  });

  it("records the environment's agent choice; unknown ids default to Claude Code", () => {
    cp.create(baseImage("golden/go"), "monaco", "codex");
    expect(cp.workspaces({ mine: true }).some((w) => cp.agentFor(w.id) === "codex")).toBe(true);
    expect(cp.agentFor("does-not-exist")).toBe("claude-code");
  });

  it("derives a per-workspace timeline + filters the audit ledger to that workspace", () => {
    const ws = cp.workspaces()[0];
    expect(ws).toBeDefined();
    if (ws === undefined) throw new Error("no workspace");
    const timeline = cp.timelineFor(ws.id);
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline[0]?.event).toBe("created"); // oldest-first, starts at creation
    // The per-workspace audit is a subset of the full ledger, all targeting this workspace.
    const history = cp.auditFor(ws.id);
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((e) => e.target === ws.id)).toBe(true);
  });

  it("registers + removes SSH keys for the current user, validating the key type", () => {
    const before = cp.sshKeys().length;
    cp.addSshKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEYdata00000000 me@host", "my laptop");
    const after = cp.sshKeys();
    expect(after.length).toBe(before + 1);
    expect(after[0]?.keyType).toBe("ssh-ed25519");
    // A malformed key (no data blob) is rejected.
    expect(() => {
      cp.addSshKey("ssh-ed25519", "bad");
    }).toThrow();
    const added = after.find((k) => k.label === "my laptop");
    expect(added).toBeDefined();
    if (added !== undefined) {
      cp.removeSshKey(added.id);
      expect(cp.sshKeys().some((k) => k.id === added.id)).toBe(false);
    }
  });

  it("derives health and overlays it on the system topology", () => {
    const report = cp.healthReport();
    expect(report.components.some((c) => c.component === "control-plane")).toBe(true);
    // The seed includes an error workspace, so compute degrades — the roll-up isn't "ok".
    expect(report.status).not.toBe("ok");
    const nodes = cp.topology();
    expect(nodes.find((n) => n.id === "control-plane")?.status).toBe("ok");
    expect(nodes.find((n) => n.id === "user")?.status).toBe("unknown"); // boundary node, no check
  });

  it("discards a stale-schema persisted blob and re-seeds (the blank-screen regression)", () => {
    // The pre-agents blob: an older version with no `agents`/`editors` maps. Loading it into the
    // newer code used to crash on `state.agents[id]`; it must now be discarded + re-seeded.
    globalThis.localStorage.setItem(
      "edd-demo:state:v1",
      JSON.stringify({
        version: 1,
        users: [{ id: "x", name: "X", email: "x@x", role: "developer" }],
        currentUserId: "x",
        catalog: [],
        workspaces: [],
        audit: [],
      }),
    );
    const fresh = new DemoControlPlane();
    expect(fresh.workspaces().length).toBeGreaterThan(0); // re-seeded, not the empty stale blob
    const first = fresh.workspaces()[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      expect(() => fresh.agentFor(first.id)).not.toThrow();
      expect(() => fresh.editorFor(first.id)).not.toThrow();
    }
  });

  it("reset clears persisted state", () => {
    cp.create(baseImage("golden/go"));
    cp.reset();
    expect(globalThis.localStorage.getItem("edd-demo:state:v1")).toBeNull();
  });
});
