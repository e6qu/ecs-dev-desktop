// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COST_SCOPE, applicationReleaseRevision, parseEnv } from "./index";

afterEach(() => vi.unstubAllEnvs());

describe("parseEnv", () => {
  it("applies defaults when values are absent", () => {
    const env = parseEnv({ AWS_REGION: "us-east-1" });
    expect(env.NODE_ENV).toBe("development");
    expect(env.DYNAMODB_TABLE).toBe("ecs-dev-desktop");
    expect(env.EDD_COST_SCOPE).toBe(DEFAULT_COST_SCOPE);
  });

  it("requires a region rather than guessing one", () => {
    // A region is a deployment coordinate: defaulting it sends real calls to a
    // region the operator never chose.
    expect(() => parseEnv({})).toThrow();
  });

  it("accepts an explicit cost scope", () => {
    const env = parseEnv({ AWS_REGION: "us-east-1", EDD_COST_SCOPE: "edd-beta" });
    expect(env.EDD_COST_SCOPE).toBe("edd-beta");
  });

  it("rejects an invalid NODE_ENV", () => {
    expect(() => parseEnv({ NODE_ENV: "staging" })).toThrow();
  });
});

describe("applicationReleaseRevision", () => {
  it("prefers the deployment-neutral revision coordinate", () => {
    vi.stubEnv("APPLICATION_RELEASE_REVISION", `sha256:${"a".repeat(64)}`);
    vi.stubEnv("EDD_BUILD_SHA", "b".repeat(40));
    expect(applicationReleaseRevision()).toBe(`sha256:${"a".repeat(64)}`);
  });

  it("accepts the immutable source revision baked into release images", () => {
    vi.stubEnv("APPLICATION_RELEASE_REVISION", "");
    vi.stubEnv("EDD_BUILD_SHA", "b".repeat(40));
    expect(applicationReleaseRevision()).toBe("b".repeat(40));
  });

  it.each(["", "main", "ABCDEF012345", "sha256:not-a-digest"])(
    "rejects mutable or malformed revision %j",
    (revision) => {
      vi.stubEnv("APPLICATION_RELEASE_REVISION", revision);
      vi.stubEnv("EDD_BUILD_SHA", "");
      expect(() => applicationReleaseRevision()).toThrow(/immutable deployed release/);
    },
  );
});
