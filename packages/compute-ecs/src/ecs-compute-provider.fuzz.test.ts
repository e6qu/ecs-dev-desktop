// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Task } from "@aws-sdk/client-ecs";
import { baseImage } from "@edd/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type EcsComputeConfig,
  taskDefinitionFamily,
  taskPrivateIp,
  taskReady,
  workspaceEnvironment,
} from "./ecs-compute-provider";

const FAMILY_RE = /^edd-ws-[A-Za-z0-9-]+$/;
// The replace/`slice(0, 200)` bounds the image-derived suffix; with the `edd-ws-`
// prefix the family is at most 207 chars (ECS allows up to 255). Keep a generous
// upper bound the implementation must never exceed.
const FAMILY_MAX_LEN = "edd-ws-".length + 200;

// An image whose normalized slug is non-empty: at least one char that is not
// collapsed away to nothing. (The empty/all-collapsing case is covered separately:
// the function fails loudly there.)
const nonEmptySlugImageArb = fc.string().filter((s) => s.replace(/[^a-zA-Z0-9-]/g, "-") !== "");

describe("taskDefinitionFamily (property)", () => {
  it("always yields a valid edd-ws-* family within the length bound, deterministically", () => {
    fc.assert(
      fc.property(nonEmptySlugImageArb, (s) => {
        const fam = taskDefinitionFamily(baseImage(s));
        // The prefix is always present.
        expect(fam.startsWith("edd-ws-")).toBe(true);
        // The whole family matches the allowed character set (the suffix collapses
        // every disallowed char to `-`, so there is always at least one suffix char).
        expect(fam).toMatch(FAMILY_RE);
        expect(fam.length).toBeLessThanOrEqual(FAMILY_MAX_LEN);
        // Deterministic: same input → same output.
        expect(taskDefinitionFamily(baseImage(s))).toBe(fam);
      }),
    );
  });

  it("never lets a disallowed character survive into the family", () => {
    fc.assert(
      fc.property(nonEmptySlugImageArb, (s) => {
        const fam = taskDefinitionFamily(baseImage(s));
        // Strip the fixed prefix; the remainder must be only [A-Za-z0-9-].
        const suffix = fam.slice("edd-ws-".length);
        expect(suffix).toMatch(/^[A-Za-z0-9-]+$/);
      }),
    );
  });

  it("fails loudly on an empty image rather than emitting a bare `edd-ws-` family", () => {
    // The fuzz run surfaced this: an empty (or all-collapsing) image used to return
    // exactly "edd-ws-", a degenerate family that collides every such image onto one
    // name. The function now rejects it.
    expect(() => taskDefinitionFamily(baseImage(""))).toThrow(/empty/);
  });
});

// fast-check arbitrary for the optional pieces of EcsComputeConfig the env builder reads.
const configArb: fc.Arbitrary<EcsComputeConfig> = fc.record(
  {
    subnets: fc.array(fc.string()),
    ebsRoleArn: fc.string(),
    controlPlaneUrl: fc.option(fc.string(), { nil: undefined }),
    // The env builder only checks the secret is defined (it HMACs whatever it is),
    // so a non-empty string suffices; no need to constrain to hex here.
    agentSecret: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    connectionSecret: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    heartbeatIntervalS: fc.option(fc.integer(), { nil: undefined }),
  },
  { requiredKeys: ["subnets", "ebsRoleArn"] },
);

const repoArb = fc.option(
  fc.record({
    url: fc.option(fc.string(), { nil: undefined }),
    ref: fc.option(fc.string(), { nil: undefined }),
  }),
  { nil: undefined },
);

describe("workspaceEnvironment (property)", () => {
  it("honours omitAgentToken / omitConnectionToken and always carries a defined EDD_WORKSPACE_ID", () => {
    fc.assert(
      fc.property(
        configArb,
        fc.string(),
        repoArb,
        fc.record({
          omitAgentToken: fc.boolean(),
          omitConnectionToken: fc.boolean(),
        }),
        (config, wsId, repo, opts) => {
          const env = workspaceEnvironment(config, wsId, repo, opts);
          const names = env.map((e) => e.name);

          // EDD_WORKSPACE_ID is always present exactly once and equals wsId.
          const wsEntries = env.filter((e) => e.name === "EDD_WORKSPACE_ID");
          expect(wsEntries).toHaveLength(1);
          expect(wsEntries[0]?.value).toBe(wsId);

          // omit flags suppress the corresponding token entry.
          if (opts.omitAgentToken) expect(names).not.toContain("EDD_AGENT_TOKEN");
          if (opts.omitConnectionToken) expect(names).not.toContain("CONNECTION_TOKEN");

          // No undefined-valued entries leak in (every value is a string).
          for (const e of env) {
            expect(typeof e.value).toBe("string");
          }
        },
      ),
    );
  });
});

// An arbitrary, possibly-partial `Task`: arbitrary lastStatus + arbitrary
// attachment shapes (some resembling ENI/EBS, some garbage) + container IPs.
const detailArb = fc.record(
  {
    name: fc.option(fc.string(), { nil: undefined }),
    value: fc.option(fc.string(), { nil: undefined }),
  },
  { requiredKeys: [] },
);
const attachmentArb = fc.record(
  {
    type: fc.option(
      fc.constantFrom("ElasticNetworkInterface", "AmazonElasticBlockStorage", "Other"),
      { nil: undefined },
    ),
    details: fc.option(fc.array(detailArb), { nil: undefined }),
  },
  { requiredKeys: [] },
);
const taskArb: fc.Arbitrary<Task | undefined> = fc.option(
  fc.record(
    {
      lastStatus: fc.option(
        fc.constantFrom("RUNNING", "PENDING", "PROVISIONING", "STOPPED", "DEPROVISIONING"),
        { nil: undefined },
      ),
      attachments: fc.option(fc.array(attachmentArb), { nil: undefined }),
      containers: fc.option(
        fc.array(
          fc.record(
            {
              networkInterfaces: fc.option(
                fc.array(
                  fc.record(
                    { privateIpv4Address: fc.option(fc.string(), { nil: undefined }) },
                    { requiredKeys: [] },
                  ),
                ),
                { nil: undefined },
              ),
            },
            { requiredKeys: [] },
          ),
        ),
        { nil: undefined },
      ),
    },
    { requiredKeys: [] },
  ),
  { nil: undefined },
);

describe("taskReady / taskPrivateIp (property)", () => {
  it("never throw on arbitrary/partial task shapes", () => {
    fc.assert(
      fc.property(taskArb, (task) => {
        expect(() => taskPrivateIp(task)).not.toThrow();
        expect(() => taskReady(task)).not.toThrow();
      }),
    );
  });

  it("taskReady returns coordinates only when RUNNING + volume + ENI IP all present", () => {
    fc.assert(
      fc.property(taskArb, (task) => {
        const ready = taskReady(task);
        if (ready !== undefined) {
          // Must have been RUNNING with both a volume id and a private IP.
          expect(task?.lastStatus).toBe("RUNNING");
          expect(taskPrivateIp(task)).toBe(ready.sshHost);
          expect(ready.volumeId.length).toBeGreaterThan(0);
          expect(ready.sshHost.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});
