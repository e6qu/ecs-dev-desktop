// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  baseImage,
  isoTimestamp,
  ownerId,
  provision,
  taskId,
  volumeId,
  workspaceId,
} from "@edd/core";
import { describe, expect, it } from "vitest";

import { toWorkspaceDto } from "./dto";

describe("toWorkspaceDto", () => {
  it("projects the public fields and drops runtime bindings", () => {
    const ws = provision({
      id: workspaceId("ws-1"),
      ownerId: ownerId("alice"),
      baseImage: baseImage("golden/node:20"),
      volumeId: volumeId("vol-1"),
      taskId: taskId("task-1"),
      at: isoTimestamp("2026-06-01T00:00:00.000Z"),
    });
    expect(toWorkspaceDto(ws)).toEqual({
      id: "ws-1",
      ownerId: "alice",
      baseImage: "golden/node:20",
      state: "running",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
  });
});
