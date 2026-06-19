// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  evaluateIamPermissions,
  IAM_REQUIREMENTS,
  requiredActions,
  type IamActionDecision,
} from "./iam-requirements";

const allAllowed = (component: "control-plane" | "reconciler"): IamActionDecision[] =>
  requiredActions(component).map((action) => ({ action, allowed: true }));

describe("IAM_REQUIREMENTS manifest", () => {
  it("covers both runtime components with non-empty, namespaced actions", () => {
    for (const component of ["control-plane", "reconciler"] as const) {
      const reqs = IAM_REQUIREMENTS[component];
      expect(reqs.length).toBeGreaterThan(0);
      for (const req of reqs) {
        expect(req.actions.length).toBeGreaterThan(0);
        // Every action is `service:Action` (the shape the IAM simulator expects).
        for (const a of req.actions) expect(a).toMatch(/^[a-z0-9-]+:[A-Za-z]+$/);
      }
    }
  });

  it("flattens + de-duplicates required actions, sorted", () => {
    const actions = requiredActions("control-plane");
    expect(actions).toContain("ecs:RunTask");
    expect(actions).toContain("iam:PassRole");
    expect([...actions]).toEqual([...actions].sort());
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("carries the condition context scoped statements need (ecs:cluster, ResourceTag, PassedToService)", () => {
    const ctx = IAM_REQUIREMENTS["control-plane"].flatMap((r) => r.context ?? []);
    const keys = ctx.map((c) => c.key);
    expect(keys).toContain("ecs:cluster");
    expect(keys).toContain("aws:ResourceTag/edd:managed");
    expect(keys).toContain("iam:PassedToService");
  });
});

describe("evaluateIamPermissions", () => {
  it("→ unknown when the preflight could not run (never drift)", () => {
    const check = evaluateIamPermissions("control-plane", {
      kind: "unavailable",
      reason: "no caller identity",
    });
    expect(check.status).toBe("unknown");
    expect(check.name).toBe("iam-permissions:control-plane");
    expect(check.detail).toContain("no caller identity");
  });

  it("→ ok when every required action is allowed", () => {
    const check = evaluateIamPermissions("control-plane", {
      kind: "checked",
      decisions: allAllowed("control-plane"),
    });
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("required actions allowed");
  });

  it("→ drift naming the denied actions", () => {
    const decisions = allAllowed("reconciler").map((d) =>
      d.action === "ecs:StopTask" ? { ...d, allowed: false } : d,
    );
    const check = evaluateIamPermissions("reconciler", { kind: "checked", decisions });
    expect(check.status).toBe("drift");
    expect(check.detail).toContain("ecs:StopTask");
  });

  it("→ drift when a required action is missing from the decisions entirely", () => {
    // Simulate returned decisions for all but one required action.
    const decisions = allAllowed("control-plane").filter(
      (d) => d.action !== "cloudtrail:LookupEvents",
    );
    const check = evaluateIamPermissions("control-plane", { kind: "checked", decisions });
    expect(check.status).toBe("drift");
    expect(check.detail).toContain("cloudtrail:LookupEvents");
  });
});
