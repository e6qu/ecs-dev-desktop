// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { workspacePrincipal } from "./index";

describe("workspacePrincipal", () => {
  it("derives a principal from a valid username", () => {
    expect(workspacePrincipal("alice")).toBe("dev-alice");
  });

  it("rejects an unsafe username", () => {
    expect(() => workspacePrincipal("../root")).toThrow();
  });
});
