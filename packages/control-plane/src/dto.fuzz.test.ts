// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  baseImage,
  baseImageId,
  isoTimestamp,
  ownerId,
  snapshotId,
  taskId,
  volumeId,
  workspaceId,
} from "@edd/core";
import type { Workspace } from "@edd/core";

import { toWorkspaceDetail, toWorkspaceDto } from "./dto";
import { toBaseImageDto } from "./base-image-dto";

const NOW = isoTimestamp("2026-01-01T00:00:00.000Z");

function makeWs(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: workspaceId("ws-1"),
    ownerId: ownerId("alice"),
    baseImage: baseImage("golden/node:20"),
    state: "running",
    desiredState: "present",
    createdAt: NOW,
    lastActivity: NOW,
    volumeId: volumeId("vol-1"),
    taskId: taskId("task-1"),
    ...overrides,
  };
}

describe("DTO mapping (fuzz)", () => {
  describe("toWorkspaceDto", () => {
    it("always sets required fields", () => {
      const ws = makeWs();
      const dto = toWorkspaceDto(ws);
      expect(dto.id).toBe(ws.id);
      expect(dto.ownerId).toBe(ws.ownerId);
      expect(dto.baseImage).toBe(ws.baseImage);
      expect(dto.state).toBe(ws.state);
      expect(dto.createdAt).toBe(ws.createdAt);
      expect(dto.availableActions).toBeInstanceOf(Array);
    });

    it("never leaks runtime fields", () => {
      const ws = makeWs({
        volumeId: volumeId("vol-1"),
        taskId: taskId("task-1"),
        sshHost: "10.0.0.1",
        ownerEmail: "alice@example.com" as never,
        desiredState: "present",
        deleteRequestedAt: NOW,
        lastActivity: NOW,
        latestSnapshotId: snapshotId("snap-1"),
      });
      const dto = toWorkspaceDto(ws);
      expect(dto).not.toHaveProperty("volumeId");
      expect(dto).not.toHaveProperty("taskId");
      expect(dto).not.toHaveProperty("sshHost");
      expect(dto).not.toHaveProperty("ownerEmail");
      expect(dto).not.toHaveProperty("desiredState");
      expect(dto).not.toHaveProperty("deleteRequestedAt");
      expect(dto).not.toHaveProperty("lastActivity");
      expect(dto).not.toHaveProperty("latestSnapshotId");
    });

    it("optional fields present iff defined on input", () => {
      const withAll: Workspace = makeWs({
        ownerRole: "admin",
        repoUrl: "https://github.com/org/repo",
        editor: "openvscode",
        functional: "ok",
      });
      const dto = toWorkspaceDto(withAll);
      expect(dto).toHaveProperty("ownerRole", "admin");
      expect(dto).toHaveProperty("repoUrl");
      expect(dto).toHaveProperty("editor");
      expect(dto).toHaveProperty("functional", "ok");

      const stripped = toWorkspaceDto(makeWs());
      expect(stripped).not.toHaveProperty("ownerRole");
      expect(stripped).not.toHaveProperty("repoUrl");
      expect(stripped).not.toHaveProperty("editor");
      expect(stripped).not.toHaveProperty("functional");
    });

    it("availableActions is a fresh array each call", () => {
      const ws = makeWs({ state: "running" });
      const a = toWorkspaceDto(ws);
      const b = toWorkspaceDto(ws);
      expect(a.availableActions).not.toBe(b.availableActions);
      expect(a.availableActions).toEqual(b.availableActions);
    });
  });

  describe("toWorkspaceDetail", () => {
    it("includes runtime fields that dto omits", () => {
      const ws = makeWs({
        volumeId: volumeId("vol-1"),
        taskId: taskId("task-1"),
        sshHost: "10.0.0.1",
        latestSnapshotId: snapshotId("snap-1"),
      });
      const detail = toWorkspaceDetail(ws);
      expect(detail.volumeId).toBe(ws.volumeId);
      expect(detail.taskId).toBe(ws.taskId);
      expect(detail.sshHost).toBe(ws.sshHost);
      expect(detail.latestSnapshotId).toBe(ws.latestSnapshotId);
    });

    it("always sets required fields", () => {
      const ws = makeWs();
      const detail = toWorkspaceDetail(ws);
      expect(detail.id).toBe(ws.id);
      expect(detail.state).toBe(ws.state);
      expect(detail.availableActions).toBeInstanceOf(Array);
    });
  });

  describe("toBaseImageDto", () => {
    it("copies tags and tools into fresh arrays", () => {
      const entry = {
        id: baseImageId("img-1"),
        name: "Node 20",
        image: baseImage("golden/node:20"),
        description: "LTS",
        tags: ["typescript", "node"],
        tools: ["pnpm"],
        enabled: true,
        editor: "openvscode" as const,
        createdAt: NOW,
      };
      const dto = toBaseImageDto(entry);
      expect(dto.tags).toEqual(["typescript", "node"]);
      expect(dto.tools).toEqual(["pnpm"]);
      expect(dto.tags).not.toBe(entry.tags);
      expect(dto.tools).not.toBe(entry.tools);
    });

    it("round-trips all scalar fields", () => {
      const entry = {
        id: baseImageId("img-1"),
        name: "Go",
        image: baseImage("golden/go:1.22"),
        description: "Go 1.22",
        tags: [],
        tools: [],
        enabled: false,
        editor: "monaco" as const,
        createdAt: NOW,
      };
      const dto = toBaseImageDto(entry);
      expect(dto.id).toBe(entry.id);
      expect(dto.name).toBe(entry.name);
      expect(dto.image).toBe(entry.image);
      expect(dto.description).toBe(entry.description);
      expect(dto.enabled).toBe(false);
      expect(dto.editor).toBe("monaco");
    });
  });
});
