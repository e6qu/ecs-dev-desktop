// SPDX-License-Identifier: AGPL-3.0-or-later
import { fixedClock, type CompiledTrafficFilter, type TrafficFilterPolicy } from "@edd/core";
import type { TrafficFilterEntity } from "@edd/db";
import { describe, expect, it, vi } from "vitest";

import type { AuditAction } from "./stored-audit-source";
import {
  TRAFFIC_FILTER_SCHEMA_VERSION,
  TrafficFilterService,
  WafApplyError,
  type WafApplier,
} from "./traffic-filter-service";

interface StoredRow {
  id: string;
  schemaVersion: number;
  mode: "allow" | "block";
  cidrs: string[];
  countries: string[];
  asns: number[];
  presets: string[];
  blockAnonymous: boolean;
  appliedAt?: string;
  appliedError?: string;
  updatedAt: string;
}

/** In-memory stand-in for the ElectroDB `trafficFilterPolicy` entity — only the
 * `get(...).go()` / `put(...).go()` the service calls. The real shape is exercised by
 * `traffic-filter-service.integ.ts` against the sim's DynamoDB. */
function fakeEntity(seed?: StoredRow): {
  entity: TrafficFilterEntity;
  row: () => StoredRow | null;
} {
  let row: StoredRow | null = seed ?? null;
  const entity = {
    put(item: StoredRow) {
      return {
        go: () => {
          row = item;
          return Promise.resolve({ data: item });
        },
      };
    },
    get(_key: { id: string }) {
      return { go: () => Promise.resolve({ data: row }) };
    },
  } as unknown as TrafficFilterEntity;
  return { entity, row: () => row };
}

function fakeAudit(): { record: (a: AuditAction) => Promise<void>; calls: AuditAction[] } {
  const calls: AuditAction[] = [];
  return {
    calls,
    record: (a) => {
      calls.push(a);
      return Promise.resolve();
    },
  };
}

const CLOCK = fixedClock("2026-07-11T09:00:00.000Z");

const VALID_POLICY: TrafficFilterPolicy = {
  version: 1,
  mode: "block",
  cidrs: ["203.0.113.0/24"],
  countries: ["US", "DE"],
  asns: [16509],
  presets: ["cloudflare"],
  blockAnonymous: true,
};

describe("TrafficFilterService.getState", () => {
  it("returns the empty allow-all policy when nothing is persisted", async () => {
    const { entity } = fakeEntity();
    const waf: WafApplier = { apply: vi.fn() };
    const svc = new TrafficFilterService({ store: entity, waf, clock: CLOCK, audit: fakeAudit() });

    const state = await svc.getState();
    expect(state.policy.mode).toBe("block");
    expect(state.defaultAction).toBe("allow");
    expect(state.compiled).toEqual([]);
    expect(state.presets).toContain("aws");
    expect(state.appliedAt).toBeUndefined();
    expect(state.appliedError).toBeUndefined();
  });

  it("discards a stale-schema-version row and falls back to empty (§6.5a)", async () => {
    const { entity } = fakeEntity({
      id: "traffic-filter",
      schemaVersion: TRAFFIC_FILTER_SCHEMA_VERSION + 1,
      mode: "allow",
      cidrs: ["10.0.0.0/8"],
      countries: [],
      asns: [],
      presets: [],
      blockAnonymous: false,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const waf: WafApplier = { apply: vi.fn() };
    const svc = new TrafficFilterService({ store: entity, waf, clock: CLOCK, audit: fakeAudit() });

    const state = await svc.getState();
    expect(state.policy.cidrs).toEqual([]);
    expect(state.defaultAction).toBe("allow"); // empty policy → block mode → default allow
  });
});

describe("TrafficFilterService.updatePolicy — happy path", () => {
  it("compiles, persists (versioned), applies to WAF, records appliedAt, and audits", async () => {
    const { entity, row } = fakeEntity();
    let applied: CompiledTrafficFilter | undefined;
    const waf: WafApplier = {
      apply: (compiled) => {
        applied = compiled;
        return Promise.resolve();
      },
    };
    const audit = fakeAudit();
    const svc = new TrafficFilterService({ store: entity, waf, clock: CLOCK, audit });

    const state = await svc.updatePolicy(VALID_POLICY, "alice");

    // Persisted, versioned.
    expect(row()).toMatchObject({
      id: "traffic-filter",
      schemaVersion: TRAFFIC_FILTER_SCHEMA_VERSION,
      mode: "block",
      cidrs: ["203.0.113.0/24"],
      appliedAt: "2026-07-11T09:00:00.000Z",
    });
    expect(row()?.appliedError).toBeUndefined();

    // Applied the COMPILED rules (block mode → default allow; anonymous block first).
    expect(applied?.defaultAction).toBe("allow");
    expect(applied?.rules[0]).toEqual({ kind: "managed-anonymous", action: "block" });
    expect(applied?.rules.some((r) => r.kind === "ip")).toBe(true);

    // State reflects the apply + audit recorded.
    expect(state.appliedAt).toBe("2026-07-11T09:00:00.000Z");
    expect(state.appliedError).toBeUndefined();
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]?.action).toBe("traffic-filter.updated");
    expect(audit.calls[0]?.actor).toBe("alice");
  });
});

describe("TrafficFilterService.updatePolicy — invalid policy", () => {
  it("throws before any write or apply (fail loud)", async () => {
    const { entity, row } = fakeEntity();
    const apply = vi.fn();
    const waf: WafApplier = { apply };
    const audit = fakeAudit();
    const svc = new TrafficFilterService({ store: entity, waf, clock: CLOCK, audit });

    const bad: TrafficFilterPolicy = { ...VALID_POLICY, countries: ["USA"] };
    await expect(svc.updatePolicy(bad, "alice")).rejects.toThrow(/invalid traffic-filter policy/);
    expect(row()).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    expect(audit.calls).toHaveLength(0);
  });
});

describe("TrafficFilterService.updatePolicy — WAF apply failure", () => {
  it("persists the policy, records appliedError, audits the failure, and throws WafApplyError", async () => {
    const { entity, row } = fakeEntity();
    const waf: WafApplier = {
      apply: () => Promise.reject(new Error("LockToken mismatch")),
    };
    const audit = fakeAudit();
    const svc = new TrafficFilterService({ store: entity, waf, clock: CLOCK, audit });

    await expect(svc.updatePolicy(VALID_POLICY, "bob")).rejects.toBeInstanceOf(WafApplyError);

    // The policy IS persisted, with the recorded error and no appliedAt.
    expect(row()).toMatchObject({ mode: "block", appliedError: "LockToken mismatch" });
    expect(row()?.appliedAt).toBeUndefined();

    // The failure is auditable and visible in getState.
    expect(audit.calls[0]?.action).toBe("traffic-filter.apply-failed");
    const state = await svc.getState();
    expect(state.appliedError).toBe("LockToken mismatch");
    expect(state.appliedAt).toBeUndefined();
  });
});
