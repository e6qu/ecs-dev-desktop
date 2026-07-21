// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { immutableReleaseEnvironment } from "./release-env";

describe("immutableReleaseEnvironment", () => {
  it("uses the exact checked-out revision when deployment provenance is absent", () => {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    expect(immutableReleaseEnvironment({})).toEqual({ EDD_BUILD_SHA: revision });
  });

  it("preserves an explicit application release revision", () => {
    const revision = `sha256:${"a".repeat(64)}`;

    expect(immutableReleaseEnvironment({ APPLICATION_RELEASE_REVISION: revision })).toEqual({
      APPLICATION_RELEASE_REVISION: revision,
    });
  });

  it("preserves an explicit image source revision", () => {
    const revision = "b".repeat(40);

    expect(immutableReleaseEnvironment({ EDD_BUILD_SHA: revision })).toEqual({
      EDD_BUILD_SHA: revision,
    });
  });
});
