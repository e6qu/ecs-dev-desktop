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

  it("round-trips repoUrl (the in-workspace git-credential broker reads it back via get())", () => {
    const ws = provision({
      id: workspaceId("ws-2"),
      ownerId: ownerId("bob"),
      baseImage: baseImage("golden/node:20"),
      repoUrl: "https://github.com/acme/app",
      volumeId: volumeId("vol-2"),
      taskId: taskId("task-2"),
      at: isoTimestamp("2026-06-01T00:00:00.000Z"),
    });
    expect(toWorkspaceDto(ws).repoUrl).toBe("https://github.com/acme/app");
  });

  it("omits repoUrl when the session has no repo", () => {
    const ws = provision({
      id: workspaceId("ws-3"),
      ownerId: ownerId("carol"),
      baseImage: baseImage("golden/node:20"),
      volumeId: volumeId("vol-3"),
      taskId: taskId("task-3"),
      at: isoTimestamp("2026-06-01T00:00:00.000Z"),
    });
    expect("repoUrl" in toWorkspaceDto(ws)).toBe(false);
  });
});
