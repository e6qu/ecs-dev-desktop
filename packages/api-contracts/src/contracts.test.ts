// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { createWorkspaceRequest, workspace } from "./index";

describe("api-contracts", () => {
  it("accepts a valid workspace", () => {
    const parsed = workspace.parse({
      id: "ws-1",
      ownerId: "user-1",
      baseImage: "golden/node:20",
      state: "running",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    expect(parsed.state).toBe("running");
  });

  it("rejects an empty baseImage on create", () => {
    expect(() => createWorkspaceRequest.parse({ baseImage: "" })).toThrow();
  });
});
