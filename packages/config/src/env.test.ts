// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseEnv } from "./index";

describe("parseEnv", () => {
  it("applies defaults when values are absent", () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe("development");
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.DYNAMODB_TABLE).toBe("ecs-dev-desktop");
  });

  it("rejects an invalid NODE_ENV", () => {
    expect(() => parseEnv({ NODE_ENV: "staging" })).toThrow();
  });
});
