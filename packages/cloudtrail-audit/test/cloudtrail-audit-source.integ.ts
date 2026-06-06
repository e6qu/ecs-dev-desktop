// SPDX-License-Identifier: AGPL-3.0-or-later
import { awsSim, DEFAULT_AWS_REGION } from "@edd/config";
import { describe, expect, it } from "vitest";

import { CloudTrailAuditSource } from "../src/cloudtrail-audit-source";

// Point the AWS SDK at the sockerless AWS simulator (Tier-2 harness, from source).
process.env.AWS_ENDPOINT_URL ??= awsSim.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

describe("CloudTrailAuditSource against the sockerless AWS sim", () => {
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
