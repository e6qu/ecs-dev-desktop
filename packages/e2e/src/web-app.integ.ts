// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withE2EReleaseRevision } from "./web-app";

const REPO_ROOT = join(import.meta.dirname, "../../..");

describe("production web app release provenance", () => {
  it("uses the exact checked-out source revision when no deployment revision was supplied", () => {
    const expectedRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();

    expect(withE2EReleaseRevision({})).toEqual({ EDD_BUILD_SHA: expectedRevision });
  });

  it("preserves an explicit application release revision", () => {
    const revision = "a".repeat(64);
    expect(withE2EReleaseRevision({ APPLICATION_RELEASE_REVISION: revision })).toEqual({
      APPLICATION_RELEASE_REVISION: revision,
    });
  });

  it("preserves a source revision already supplied by the caller", () => {
    const revision = "b".repeat(40);
    expect(withE2EReleaseRevision({ EDD_BUILD_SHA: revision })).toEqual({
      EDD_BUILD_SHA: revision,
    });
  });
});
