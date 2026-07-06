// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { workspacePrincipal } from "./index";

describe("workspacePrincipal", () => {
  it("derives a principal from a valid workspace id", () => {
    expect(workspacePrincipal("ws-abc123")).toBe("dev-ws-abc123");
  });

  it("rejects an unsafe/non-workspace-id value", () => {
    expect(() => workspacePrincipal("../root")).toThrow();
  });
});
