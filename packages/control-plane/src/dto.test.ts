// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { toWorkspaceDto } from "./dto";

describe("toWorkspaceDto", () => {
  it("projects the public fields and drops runtime bindings", () => {
    const dto = toWorkspaceDto({
      id: "ws-1",
      ownerId: "alice",
      baseImage: "golden/node:20",
      state: "running",
      createdAt: "2026-06-01T00:00:00.000Z",
      // extra fields that must NOT leak into the DTO:
      ...({ volumeId: "vol-1", taskId: "task-1", latestSnapshotId: "snap-1" } as object),
    } as never);
    expect(dto).toEqual({
      id: "ws-1",
      ownerId: "alice",
      baseImage: "golden/node:20",
      state: "running",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
  });
});
