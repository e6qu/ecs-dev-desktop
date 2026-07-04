// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  createBaseImageRequest,
  createWorkspaceRequest,
  registerSshKeyRequest,
  sshAuthorizeRequest,
  updateBaseImageRequest,
  workspace,
} from "./index";

describe("API contract input validation (fuzz)", () => {
  describe("createWorkspaceRequest", () => {
    it("accepts valid input", () => {
      expect(createWorkspaceRequest.safeParse({ baseImage: "golden/node:20" }).success).toBe(true);
      expect(
        createWorkspaceRequest.safeParse({
          baseImage: "golden/node:20",
          repoUrl: "https://x.com/a/b",
        }).success,
      ).toBe(true);
    });

    it("rejects missing baseImage", () => {
      expect(createWorkspaceRequest.safeParse({}).success).toBe(false);
      expect(createWorkspaceRequest.safeParse({ repoUrl: "https://x.com" }).success).toBe(false);
    });

    it("rejects empty/non-string baseImage", () => {
      expect(createWorkspaceRequest.safeParse({ baseImage: "" }).success).toBe(false);
      expect(createWorkspaceRequest.safeParse({ baseImage: 42 }).success).toBe(false);
      expect(createWorkspaceRequest.safeParse({ baseImage: null }).success).toBe(false);
    });

    it("rejects non-string repoUrl", () => {
      expect(createWorkspaceRequest.safeParse({ baseImage: "x", repoUrl: 42 }).success).toBe(false);
      expect(createWorkspaceRequest.safeParse({ baseImage: "x", repoUrl: null }).success).toBe(
        false,
      );
    });
  });

  describe("workspace (response DTO)", () => {
    it("rejects malformed state values", () => {
      const base = {
        id: "ws-1",
        ownerId: "alice",
        baseImage: "golden/node:20",
        state: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        availableActions: ["stop"],
      };
      expect(workspace.safeParse({ ...base, state: "invalid" }).success).toBe(false);
      expect(workspace.safeParse({ ...base, state: "" }).success).toBe(false);
      expect(workspace.safeParse({ ...base, state: 42 }).success).toBe(false);
    });

    it("rejects missing required fields", () => {
      expect(workspace.safeParse({ state: "running" }).success).toBe(false);
    });
  });

  describe("createBaseImageRequest", () => {
    it("rejects empty name", () => {
      expect(createBaseImageRequest.safeParse({ name: "", image: "golden/x" }).success).toBe(false);
    });

    it("rejects empty image", () => {
      expect(createBaseImageRequest.safeParse({ name: "X", image: "" }).success).toBe(false);
    });

    it("accepts with optional fields", () => {
      expect(
        createBaseImageRequest.safeParse({
          name: "Node 20",
          image: "golden/node:20",
          tags: ["typescript"],
          tools: ["pnpm"],
          enabled: true,
        }).success,
      ).toBe(true);
    });

    it("rejects non-array tags/tools", () => {
      expect(
        createBaseImageRequest.safeParse({ name: "X", image: "x", tags: "not-array" }).success,
      ).toBe(false);
    });
  });

  describe("updateBaseImageRequest", () => {
    it("rejects empty object (at least one field required)", () => {
      expect(updateBaseImageRequest.safeParse({}).success).toBe(false);
    });

    it("rejects empty-string name", () => {
      expect(updateBaseImageRequest.safeParse({ name: "" }).success).toBe(false);
    });

    it("accepts partial update", () => {
      expect(updateBaseImageRequest.safeParse({ enabled: false }).success).toBe(true);
      expect(updateBaseImageRequest.safeParse({ tags: ["a"] }).success).toBe(true);
    });
  });

  describe("registerSshKeyRequest", () => {
    it("rejects empty publicKey", () => {
      expect(registerSshKeyRequest.safeParse({ publicKey: "" }).success).toBe(false);
    });

    it("rejects missing publicKey", () => {
      expect(registerSshKeyRequest.safeParse({}).success).toBe(false);
    });

    it("accepts valid key with optional label", () => {
      const validKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIdGVzdEtleUZvclRlc3RpbmdPbmx5 comment";
      expect(registerSshKeyRequest.safeParse({ publicKey: validKey }).success).toBe(true);
      expect(
        registerSshKeyRequest.safeParse({
          publicKey: validKey,
          label: "my laptop",
        }).success,
      ).toBe(true);
    });
  });

  describe("sshAuthorizeRequest", () => {
    it("rejects missing fields", () => {
      expect(sshAuthorizeRequest.safeParse({}).success).toBe(false);
      expect(sshAuthorizeRequest.safeParse({ keyId: "x" }).success).toBe(false);
    });

    it("rejects empty string fields", () => {
      expect(
        sshAuthorizeRequest.safeParse({ keyId: "", signature: "sig", principal: "ws-1" }).success,
      ).toBe(false);
    });
  });
});
