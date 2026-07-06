// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based fuzz tests (fast-check) for DTO mapping functions. Pins:
// optional fields present iff defined on input; runtime fields never leak to the
// public DTO; availableActions is a fresh array; toBaseImageDto copies arrays.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  baseImage,
  baseImageId,
  isoTimestamp,
  ownerId,
  workspaceId,
  workspaceActions,
  type Workspace,
  type WorkspaceState,
} from "@edd/core";

import { toWorkspaceDetail, toWorkspaceDto } from "./dto";
import { toBaseImageDto } from "./base-image-dto";

const STATES: readonly WorkspaceState[] = [
  "provisioning",
  "running",
  "idle",
  "stopped",
  "deleting",
  "terminated",
  "error",
];

/** Build a Workspace with random optional fields. Branded types are constructed
 * via their smart constructors to avoid object-literal casts (§6.1). */
function makeRandomWorkspace(opts?: {
  state?: WorkspaceState;
  hasOwnerEmail?: boolean;
  hasOwnerRole?: boolean;
  hasRepoUrl?: boolean;
  hasEditor?: boolean;
  hasFunctional?: boolean;
}): Workspace {
  return {
    id: workspaceId("ws-fuzz"),
    ownerId: ownerId("alice"),
    baseImage: baseImage("golden/node:20"),
    state: opts?.state ?? "running",
    desiredState: "present",
    createdAt: isoTimestamp("2026-01-01T00:00:00.000Z"),
    lastActivity: isoTimestamp("2026-01-01T00:00:00.000Z"),
    ...(opts?.hasOwnerEmail ? { ownerEmail: "alice@example.com" as never } : {}),
    ...(opts?.hasOwnerRole ? { ownerRole: "admin" as const } : {}),
    ...(opts?.hasRepoUrl ? { repoUrl: "https://github.com/org/repo" } : {}),
    ...(opts?.hasEditor ? { editor: "openvscode" as const } : {}),
    ...(opts?.hasFunctional ? { functional: "ok" as const } : {}),
  };
}

const wsOptionsArb = fc.record({
  state: fc.constantFrom(...STATES),
  hasOwnerEmail: fc.boolean(),
  hasOwnerRole: fc.boolean(),
  hasRepoUrl: fc.boolean(),
  hasEditor: fc.boolean(),
  hasFunctional: fc.boolean(),
});

describe("toWorkspaceDto (fuzz)", () => {
  it("always sets required fields", () => {
    fc.assert(
      fc.property(wsOptionsArb, (opts) => {
        const ws = makeRandomWorkspace(opts);
        const dto = toWorkspaceDto(ws);
        expect(dto.id).toBe(ws.id);
        expect(dto.ownerId).toBe(ws.ownerId);
        expect(dto.baseImage).toBe(ws.baseImage);
        expect(dto.state).toBe(ws.state);
        expect(dto.createdAt).toBe(ws.createdAt);
        expect(dto.availableActions).toBeInstanceOf(Array);
      }),
    );
  });

  it("never leaks runtime fields", () => {
    fc.assert(
      fc.property(wsOptionsArb, (opts) => {
        const ws = makeRandomWorkspace(opts);
        const dto = toWorkspaceDto(ws);
        expect(dto).not.toHaveProperty("volumeId");
        expect(dto).not.toHaveProperty("taskId");
        expect(dto).not.toHaveProperty("sshHost");
        // ownerEmail is DELIBERATELY exposed since the "who started it" work: it's
        // the owner's own identity (the list is owner-scoped for non-admins), not a
        // runtime binding. Mirrored when it's present on the source record.
        if (opts.hasOwnerEmail) expect(dto.ownerEmail).toBe("alice@example.com");
        expect(dto).not.toHaveProperty("desiredState");
        expect(dto).not.toHaveProperty("deleteRequestedAt");
        // lastActivity is DELIBERATELY carried since the instant-create work:
        // the status page's phase-elapsed timer counts from it (it resets on
        // wake, timing the current launch). It is the owner's own timestamp,
        // not a runtime binding.
        expect(dto.lastActivity).toBe(ws.lastActivity);
        expect(dto).not.toHaveProperty("latestSnapshotId");
      }),
    );
  });

  it("optional fields present iff defined on input", () => {
    fc.assert(
      fc.property(wsOptionsArb, (opts) => {
        const ws = makeRandomWorkspace(opts);
        const dto = toWorkspaceDto(ws);
        expect("ownerRole" in dto).toBe(opts.hasOwnerRole);
        expect("repoUrl" in dto).toBe(opts.hasRepoUrl);
        expect("editor" in dto).toBe(opts.hasEditor);
        expect("functional" in dto).toBe(opts.hasFunctional);
      }),
    );
  });

  it("availableActions is a fresh array each call", () => {
    fc.assert(
      fc.property(wsOptionsArb, (opts) => {
        const ws = makeRandomWorkspace(opts);
        const a = toWorkspaceDto(ws);
        const b = toWorkspaceDto(ws);
        expect(a.availableActions).not.toBe(b.availableActions);
        expect([...a.availableActions]).toEqual([...workspaceActions(ws.state)]);
      }),
    );
  });
});

describe("toWorkspaceDetail (fuzz)", () => {
  it("always sets required fields and includes runtime fields", () => {
    fc.assert(
      fc.property(wsOptionsArb, (opts) => {
        const ws = makeRandomWorkspace({ ...opts, hasOwnerEmail: true });
        const detail = toWorkspaceDetail(ws);
        expect(detail.id).toBe(ws.id);
        expect(detail.state).toBe(ws.state);
        expect(detail.availableActions).toBeInstanceOf(Array);
        expect("ownerEmail" in detail).toBe(true);
      }),
    );
  });
});

describe("toBaseImageDto (fuzz)", () => {
  it("copies tags and tools into fresh arrays; all scalars round-trip", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
        fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
        fc.boolean(),
        fc.constantFrom("openvscode", "monaco"),
        (tags, tools, enabled, editor) => {
          const entry = {
            id: baseImageId("img-1"),
            name: "Test",
            image: baseImage("golden/test:1"),
            description: "desc",
            tags,
            tools,
            enabled,
            editor,
            createdAt: isoTimestamp("2026-01-01T00:00:00.000Z"),
          };
          const dto = toBaseImageDto(entry);
          expect(dto.tags).toEqual(tags);
          expect(dto.tools).toEqual(tools);
          expect(dto.tags).not.toBe(tags);
          expect(dto.tools).not.toBe(tools);
          expect(dto.enabled).toBe(enabled);
          expect(dto.editor).toBe(editor);
        },
      ),
    );
  });
});
