// SPDX-License-Identifier: AGPL-3.0-or-later
import { baseImage } from "@edd/core";
import { describe, expect, it } from "vitest";

import { taskDefinitionFamily } from "./index";

describe("taskDefinitionFamily", () => {
  it("derives a valid ECS family from a base-image reference", () => {
    expect(taskDefinitionFamily(baseImage("golden/node:20"))).toBe("edd-ws-golden-node-20");
  });

  it("replaces every character ECS families disallow", () => {
    expect(taskDefinitionFamily(baseImage("ghcr.io/acme/code:1.2"))).toMatch(/^[a-zA-Z0-9-]+$/);
  });
});
