// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { imageRepos } from "./image-ops";
import { FakeImageOps } from "./image-ops.fake";

describe("imageRepos", () => {
  it("mirrors the Terraform repo layout: control-plane, ssh-gateway, golden/<variant>", () => {
    expect(imageRepos("edd-prod", ["omnibus"])).toEqual([
      "edd-prod/control-plane",
      "edd-prod/ssh-gateway",
      "edd-prod/golden/omnibus",
    ]);
  });
  it("adds a repo per golden variant", () => {
    expect(imageRepos("edd", ["omnibus", "monaco"])).toContain("edd/golden/monaco");
  });
});

describe("FakeImageOps", () => {
  it("records started builds and returns a build id", async () => {
    const ops = new FakeImageOps();
    const id = await ops.startBuild({ target: "web", tag: "abc123", ref: "main" });
    expect(id).toBe("build-1");
    expect(ops.started[0]).toEqual({ target: "web", tag: "abc123", ref: "main" });
    expect((await ops.getBuild(id))?.status).toBe("in_progress");
  });
});
