// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based tests (fast-check) for evaluateConfigSync. Headline invariants:
// `inSync === checks.every(c => c.status !== "drift")` for ANY input, and a `down`
// dependency (dynamodb or compute) always forces `inSync: false`. Also pins that the
// identity is surfaced iff provided.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { IamIdentity, IamPreflightSignal } from "./iam-requirements";
import { evaluateConfigSync, type ConfigSyncInput, type DependencyStatus } from "./config-sync";

const depArb = fc.constantFrom<DependencyStatus>("ok", "down", "unknown");

// A sparse env: any subset of the keys the evaluator reads, plus some irrelevant noise.
const RELEVANT_KEYS = [
  "COMPUTE_PROVIDER",
  "ECS_CLUSTER",
  "ECS_SUBNETS",
  "ECS_SECURITY_GROUPS",
  "ECS_EBS_ROLE_ARN",
  "ECS_EXECUTION_ROLE_ARN",
  "ECS_TASK_ROLE_ARN",
  "CONTROL_PLANE_URL",
  "AUDIT_PROVIDER",
  "LOG_PROVIDER",
  "EDD_APP_NAME",
  "ECS_LOG_GROUP_WORKSPACES",
] as const;

const envArb = fc
  .record({
    // COMPUTE_PROVIDER drives the "real" branch; bias toward "ecs" so the real path runs.
    computeProvider: fc.option(fc.constantFrom("ecs", "fakes", ""), { nil: undefined }),
    present: fc.subarray([...RELEVANT_KEYS], { minLength: 0 }),
    blanks: fc.subarray([...RELEVANT_KEYS], { minLength: 0 }),
  })
  .map(({ computeProvider, present, blanks }) => {
    const env: Record<string, string | undefined> = {};
    for (const k of present) env[k] = `v-${k}`;
    for (const k of blanks) env[k] = ""; // present-but-empty counts as missing
    if (computeProvider !== undefined) env.COMPUTE_PROVIDER = computeProvider;
    return env;
  });

const iamArb: fc.Arbitrary<IamPreflightSignal | undefined> = fc.option(
  fc.oneof(
    fc.record({
      kind: fc.constant<"checked">("checked"),
      decisions: fc.array(
        fc.record({ action: fc.string({ minLength: 1 }), allowed: fc.boolean() }),
        { maxLength: 6 },
      ),
    }),
    fc.record({ kind: fc.constant<"unavailable">("unavailable"), reason: fc.string() }),
  ),
  { nil: undefined },
);

const identityArb: fc.Arbitrary<IamIdentity | undefined> = fc.option(
  fc.record({
    account: fc.string(),
    callerArn: fc.string(),
    principalArn: fc.option(fc.string(), { nil: null }),
  }),
  { nil: undefined },
);

const inputArb: fc.Arbitrary<ConfigSyncInput> = fc.record({
  env: envArb,
  dynamodb: depArb,
  compute: depArb,
  iam: iamArb,
  iamIdentity: identityArb,
});

describe("evaluateConfigSync — properties", () => {
  it("inSync === no check is in drift, for arbitrary input", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const report = evaluateConfigSync(input);
        expect(report.inSync).toBe(report.checks.every((c) => c.status !== "drift"));
      }),
    );
  });

  it("any `down` dependency forces inSync:false", () => {
    fc.assert(
      fc.property(inputArb, fc.boolean(), (input, hitDynamo) => {
        // Force exactly one dependency down; the other arbitrary.
        const forced: ConfigSyncInput = hitDynamo
          ? { ...input, dynamodb: "down" }
          : { ...input, compute: "down" };
        const report = evaluateConfigSync(forced);
        expect(report.inSync).toBe(false);
        // And the corresponding dependency check is drift.
        const name = hitDynamo ? "dynamodb" : "compute-cluster";
        expect(report.checks.find((c) => c.name === name)?.status).toBe("drift");
      }),
    );
  });

  it("every check status is one of ok/drift/unknown and names are non-empty", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const report = evaluateConfigSync(input);
        expect(report.checks.length).toBeGreaterThan(0);
        for (const c of report.checks) {
          expect(["ok", "drift", "unknown"]).toContain(c.status);
          expect(c.name.length).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("identity is surfaced iff iamIdentity is provided", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const report = evaluateConfigSync(input);
        if (input.iamIdentity === undefined) {
          expect(report.identity).toBeUndefined();
        } else {
          expect(report.identity).toEqual(input.iamIdentity);
        }
      }),
    );
  });
});
