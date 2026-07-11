// SPDX-License-Identifier: AGPL-3.0-or-later
import { fixedClock, type CompiledTrafficFilter, type TrafficFilterPolicy } from "@edd/core";
import {
  createDynamoClient,
  dropTable,
  dynamodb,
  ensureTable,
  makeTrafficFilterEntity,
} from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuditAction } from "./stored-audit-source";
import { TrafficFilterService, type WafApplier } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const TABLE = "ecs-dev-desktop-traffic-filter-itest";
const CLOCK = fixedClock("2026-07-11T10:00:00.000Z");

/** WAF apply is a boundary the sim does not model; fake it and record what was
 * applied. The store round-trip (this suite's subject) is the REAL sim DynamoDB. */
function recordingWaf(): { waf: WafApplier; applied: CompiledTrafficFilter[] } {
  const applied: CompiledTrafficFilter[] = [];
  return {
    applied,
    waf: {
      apply: (c) => {
        applied.push(c);
        return Promise.resolve();
      },
    },
  };
}

function fakeAudit(): { record: (a: AuditAction) => Promise<void> } {
  return { record: () => Promise.resolve() };
}

describe("TrafficFilterService store round-trip (real DynamoDB)", () => {
  let client: ReturnType<typeof createDynamoClient>;

  function makeService(): { svc: TrafficFilterService; applied: CompiledTrafficFilter[] } {
    const { waf, applied } = recordingWaf();
    const svc = new TrafficFilterService({
      store: makeTrafficFilterEntity(client, TABLE),
      waf,
      clock: CLOCK,
      audit: fakeAudit(),
    });
    return { svc, applied };
  }

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TABLE);
    await ensureTable(client, TABLE);
  });

  afterAll(async () => {
    await dropTable(createDynamoClient(), TABLE);
  });

  it("returns the empty policy before anything is stored", async () => {
    const { svc } = makeService();
    const state = await svc.getState();
    expect(state.policy.mode).toBe("block");
    expect(state.compiled).toEqual([]);
    expect(state.appliedAt).toBeUndefined();
  });

  it("persists a policy and reads the exact shape back through a fresh service", async () => {
    const policy: TrafficFilterPolicy = {
      version: 1,
      mode: "allow",
      cidrs: ["198.51.100.0/24"],
      countries: ["US", "GB"],
      asns: [15169],
      presets: ["aws"],
      blockAnonymous: true,
    };
    const { svc, applied } = makeService();
    await svc.updatePolicy(policy, "operator");
    expect(applied).toHaveLength(1);
    expect(applied[0]?.defaultAction).toBe("block"); // allow mode → default deny

    // A brand-new service instance reads the persisted row (not in-process state).
    const { svc: fresh } = makeService();
    const state = await fresh.getState();
    expect(state.policy).toMatchObject({
      mode: "allow",
      cidrs: ["198.51.100.0/24"],
      countries: ["US", "GB"],
      asns: [15169],
      presets: ["aws"],
      blockAnonymous: true,
    });
    expect(state.defaultAction).toBe("block");
    expect(state.appliedAt).toBe("2026-07-11T10:00:00.000Z");
    // Compiled preview includes the anonymous block first, then ip/geo/asn allow rules.
    expect(state.compiled[0]).toMatchObject({ kind: "managed-anonymous", action: "block" });
    expect(state.compiled.some((r) => r.kind === "asn" && r.action === "allow")).toBe(true);
  });

  it("overwrites the single row on a subsequent update", async () => {
    const { svc } = makeService();
    await svc.updatePolicy(
      {
        version: 1,
        mode: "block",
        cidrs: [],
        countries: ["CN"],
        asns: [],
        presets: [],
        blockAnonymous: false,
      },
      "operator",
    );
    const { svc: fresh } = makeService();
    const state = await fresh.getState();
    expect(state.policy.mode).toBe("block");
    expect(state.policy.countries).toEqual(["CN"]);
    expect(state.policy.cidrs).toEqual([]);
    expect(state.defaultAction).toBe("allow");
  });
});
