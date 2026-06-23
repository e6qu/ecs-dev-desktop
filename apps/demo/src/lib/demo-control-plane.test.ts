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

  it("derives health and overlays it on the system topology", () => {
    const report = cp.healthReport();
    expect(report.components.some((c) => c.component === "control-plane")).toBe(true);
    // The seed includes an error workspace, so compute degrades — the roll-up isn't "ok".
    expect(report.status).not.toBe("ok");
    const nodes = cp.topology();
    expect(nodes.find((n) => n.id === "control-plane")?.status).toBe("ok");
    expect(nodes.find((n) => n.id === "user")?.status).toBe("unknown"); // boundary node, no check
  });

  it("reset clears persisted state", () => {
    cp.create(baseImage("golden/go"));
    cp.reset();
    expect(globalThis.localStorage.getItem("edd-demo:state:v1")).toBeNull();
  });
});
