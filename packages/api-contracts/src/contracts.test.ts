// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  COST_WINDOW_DAYS,
  costReportQuery,
  costWindow,
  createWorkspaceRequest,
  infrastructureReport,
  registerSshKeyRequest,
  sshKeyDto,
  workspace,
} from "./index";

const VALID_PUBKEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN4ZbjzMeOtIzbUqhfKMeKGhK/v/L86UOuNmnczpU42p vec@edd";

describe("api-contracts", () => {
  it("accepts a valid workspace", () => {
    const parsed = workspace.parse({
      id: "ws-1",
      ownerId: "user-1",
      baseImage: "golden/node:20",
      state: "running",
      createdAt: "2026-06-01T00:00:00.000Z",
      availableActions: ["snapshot", "stop", "delete"],
    });
    expect(parsed.state).toBe("running");
    expect(parsed.availableActions).toContain("stop");
  });

  it("rejects an empty baseImage on create", () => {
    expect(() => createWorkspaceRequest.parse({ baseImage: "" })).toThrow();
  });

  it("accepts a full infrastructure report (cluster + fleet + topology)", () => {
    const parsed = infrastructureReport.parse({
      health: {
        status: "ok",
        components: [{ component: "compute", status: "ok" }],
        checkedAt: "2026-06-15T00:00:00.000Z",
      },
      cluster: {
        name: "local",
        status: "local",
        runningTasks: 2,
        pendingTasks: 0,
        activeServices: 0,
        registeredContainerInstances: 0,
      },
      fleet: {
        total: 2,
        active: 2,
        byState: {
          provisioning: 0,
          running: 2,
          idle: 0,
          stopping: 0,
          stopped: 0,
          deleting: 0,
          terminated: 0,
          error: 0,
        },
      },
      topology: {
        nodes: [{ id: "compute", label: "ECS", kind: "compute", description: "x", status: "ok" }],
        edges: [{ from: "compute", to: "storage", label: "EBS" }],
      },
    });
    expect(parsed.cluster.runningTasks).toBe(2);
    expect(parsed.topology.nodes[0]?.id).toBe("compute");
  });

  it("accepts a valid SSH key registration (with optional label)", () => {
    const parsed = registerSshKeyRequest.parse({ publicKey: VALID_PUBKEY, label: "laptop" });
    expect(parsed.label).toBe("laptop");
  });

  it("accepts registration without a label", () => {
    const parsed = registerSshKeyRequest.parse({ publicKey: VALID_PUBKEY });
    expect(parsed.label).toBeUndefined();
  });

  it("rejects a malformed public key at the boundary (400, not a 500 downstream)", () => {
    expect(() => registerSshKeyRequest.parse({ publicKey: "not-a-key" })).toThrow();
  });

  it("rejects a multi-line public key (no smuggling a second key)", () => {
    expect(() =>
      registerSshKeyRequest.parse({ publicKey: `${VALID_PUBKEY}\nssh-rsa AAAAB3 evil` }),
    ).toThrow();
  });

  it("accepts a well-formed SSH key DTO", () => {
    const parsed = sshKeyDto.parse({
      id: "sshk-1",
      label: "laptop",
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:ZKsoxDkZEePudjxqp2aESf7WzZPoeDa7Mx4Dtddjjoo",
      publicKey: VALID_PUBKEY,
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    expect(parsed.keyType).toBe("ssh-ed25519");
  });

  it("defaults an absent cost window to all-time but REJECTS an invalid explicit value", () => {
    expect(costReportQuery.parse({ window: "7d" }).window).toBe("7d");
    expect(costReportQuery.parse({}).window).toBe("all"); // absent → all
    expect(costReportQuery.parse({ window: undefined }).window).toBe("all"); // absent → all
    // An explicit garbage value must fail (so the route boundary returns 400, not a
    // silent lifetime report) — `.default("all")`, not `.catch("all")`.
    expect(costReportQuery.safeParse({ window: "bogus" }).success).toBe(false);
  });

  it("maps every cost window to its day span exhaustively (all = lifetime; Nd = N days)", () => {
    // Derived from the enum, not a verbatim copy of the impl literal: a new window
    // added without a day-span mapping fails the exhaustiveness check, and each `Nd`
    // window must map to N (parsed from the key), catching a wrong span.
    expect(Object.keys(COST_WINDOW_DAYS).sort()).toEqual([...costWindow.options].sort());
    expect(COST_WINDOW_DAYS.all).toBeNull();
    for (const w of costWindow.options) {
      if (w === "all") continue;
      expect(COST_WINDOW_DAYS[w]).toBe(Number(w.replace("d", "")));
    }
  });
});
