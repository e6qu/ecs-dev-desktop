// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { buildSummaryFromCodeBuild, imageRepos } from "./image-ops";
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

describe("buildSummaryFromCodeBuild", () => {
  it("surfaces target, tag, exact source version, and trigger metadata", () => {
    const started = new Date("2026-07-07T10:00:00.000Z");
    const ended = new Date("2026-07-07T10:03:00.000Z");
    expect(
      buildSummaryFromCodeBuild({
        id: "edd-prod-build-images:build-id",
        buildStatus: "SUCCEEDED",
        currentPhase: "COMPLETED",
        startTime: started,
        endTime: ended,
        resolvedSourceVersion: "main",
        initiator: "operator",
        environment: {
          environmentVariables: [
            { name: "EDD_BUILD_TARGET", value: "golden" },
            { name: "TAG", value: "021ae3c" },
            { name: "SOURCE_REF", value: "main" },
            { name: "SOURCE_VERSION", value: "021ae3cf5485f6f02b966e3da761d10ec8c3409d" },
            { name: "EDD_TRIGGER", value: "github-main-merge" },
          ],
        },
      }),
    ).toMatchObject({
      buildId: "edd-prod-build-images:build-id",
      target: "golden",
      tag: "021ae3c",
      ref: "021ae3cf5485f6f02b966e3da761d10ec8c3409d",
      triggeredBy: "github-main-merge",
      status: "succeeded",
      durationMs: 180000,
    });
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
