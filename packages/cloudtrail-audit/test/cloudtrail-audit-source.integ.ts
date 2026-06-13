// SPDX-License-Identifier: AGPL-3.0-or-later
import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import { CreateClusterCommand, ECSClient } from "@aws-sdk/client-ecs";
import { aws, DEFAULT_AWS_REGION } from "@edd/config";
import { beforeAll, describe, expect, it } from "vitest";

import { CloudTrailAuditSource } from "../src/cloudtrail-audit-source";

// Point the AWS SDK at the sockerless AWS simulator (Tier-2 harness, from source).
process.env.AWS_ENDPOINT_URL ??= aws.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

const SIM = {
  region: DEFAULT_AWS_REGION,
  endpoint: aws.endpoint,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("CloudTrailAuditSource against the sockerless AWS sim — shape", () => {
  const src = CloudTrailAuditSource.fromEnv();

  it("recent() returns an array (empty or populated) without throwing", async () => {
    const events = await src.recent(10);
    expect(Array.isArray(events)).toBe(true);
  });

  it("recent() respects the limit", async () => {
    const events = await src.recent(5);
    expect(events.length).toBeLessThanOrEqual(5);
  });

  it("every returned event has the required AuditEvent shape", async () => {
    const events = await src.recent(20);
    for (const e of events) {
      expect(typeof e.at).toBe("string");
      expect(typeof e.actor).toBe("string");
      expect(typeof e.action).toBe("string");
      expect(typeof e.target).toBe("string");
      expect(typeof e.detail).toBe("string");
    }
  });
});

describe("CloudTrailAuditSource against the sockerless AWS sim — event content", () => {
  const src = CloudTrailAuditSource.fromEnv();
  const ctClient = new CloudTrailClient(SIM);
  const ecsClient = new ECSClient(SIM);

  // Unique cluster name so we can identify our own event in a shared sim.
  const CLUSTER_NAME = "edd-ct-integ-probe";

  beforeAll(async () => {
    // Seed: CreateCluster generates a CloudTrail event we can then look up.
    await ecsClient.send(new CreateClusterCommand({ clusterName: CLUSTER_NAME }));
  });

  async function pollForAction(action: string, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const events = await src.recent(50);
      if (events.some((e) => e.action === action)) return true;
      await sleep(200);
    }
    return false;
  }

  it("recent() surfaces the CreateCluster event after seeding", async () => {
    const found = await pollForAction("CreateCluster");
    expect(found, "CreateCluster event not found in CloudTrail within 5s").toBe(true);
  });

  it("CreateCluster event has a non-empty string target", async () => {
    const events = await src.recent(50);
    const ev = events.find((e) => e.action === "CreateCluster");
    expect(ev, "CreateCluster event must be present").toBeDefined();
    expect(ev?.target, "target must be a non-empty string").toBeTruthy();
  });

  it("recent events are ordered newest-first (ISO timestamp descending)", async () => {
    const events = await src.recent(20);
    for (let i = 1; i < events.length; i++) {
      expect(
        (events[i - 1]?.at ?? "") >= (events[i]?.at ?? ""),
        `events[${String(i - 1)}].at=${String(events[i - 1]?.at)} should be >= events[${String(i)}].at=${String(events[i]?.at)}`,
      ).toBe(true);
    }
  });

  it("LookupEvents with EventName=CreateCluster attribute filter returns only matching events", async () => {
    const out = await ctClient.send(
      new LookupEventsCommand({
        MaxResults: 10,
        LookupAttributes: [{ AttributeKey: "EventName", AttributeValue: "CreateCluster" }],
      }),
    );
    expect(
      Array.isArray(out.Events),
      "LookupEvents with LookupAttributes must return an Events array",
    ).toBe(true);
    // Server-side filter: every returned event must be a CreateCluster event.
    for (const e of out.Events ?? []) {
      expect(e.EventName, "LookupAttributes filter returned a non-matching event").toBe(
        "CreateCluster",
      );
    }
    // We seeded one CreateCluster event so at minimum one must be present.
    expect(
      out.Events?.length ?? 0,
      "LookupAttributes filter must return at least the seeded CreateCluster event",
    ).toBeGreaterThan(0);
  });
});
