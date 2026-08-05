// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COST_SCOPE,
  applicationReleaseRevision,
  parseEnv,
  simulatorCredentialOverride,
} from "./index";

afterEach(() => vi.unstubAllEnvs());

describe("parseEnv", () => {
  it("applies defaults when values are absent", () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe("development");
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.DYNAMODB_TABLE).toBe("ecs-dev-desktop");
    expect(env.EDD_COST_SCOPE).toBe(DEFAULT_COST_SCOPE);
  });

  it("accepts an explicit cost scope", () => {
    const env = parseEnv({ EDD_COST_SCOPE: "edd-beta" });
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

describe("simulatorCredentialOverride", () => {
  it("signs with the ambient role when one can be resolved", () => {
    // An ECS task presents its role through the container credentials URI. The
    // simulator authorizes against that role's policy, so overriding it with a
    // placeholder makes every call arrive as an unrecognised principal.
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_PROFILE",
    ]) {
      expect(simulatorCredentialOverride({ [name]: "set" })).toEqual({});
    }
  });

  it("falls back to the placeholder when nothing can supply credentials", () => {
    // A developer against a local simulator has no credential source at all.
    expect(simulatorCredentialOverride({})).toEqual({
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
  });

  it("treats an empty variable as absent", () => {
    expect(simulatorCredentialOverride({ AWS_ACCESS_KEY_ID: "" })).toEqual({
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
  });
});
